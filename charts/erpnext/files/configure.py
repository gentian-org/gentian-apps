"""Sign-in and the settings that go with it, written into the site from this pod's values.

Run by configure.sh on every start, so that what the values say is what the site
does: a changed client secret, a realm moved to another host, a restore from
another domain all take effect at the next start.
"""

import datetime
import json
import os

import frappe
from frappe.utils.password import set_encrypted_password

SITE = os.environ["FRAPPE_SITE"]
PROVIDER = "keycloak"  # the built-in Keycloak kind; its callback is login_via_keycloak


def say(message):
    print("erpnext-configure: " + message, flush=True)


def social_login_key():
    """The realm as the site's only sign-in provider."""
    issuer = os.environ.get("OIDC_ISSUER", "").rstrip("/")
    client_id = os.environ.get("OIDC_CLIENT_ID", "")
    client_secret = os.environ.get("OIDC_CLIENT_SECRET", "")
    enabled = os.environ.get("OIDC_ENABLED") == "true" and issuer and client_id and client_secret

    if frappe.db.exists("Social Login Key", PROVIDER):
        doc = frappe.get_doc("Social Login Key", PROVIDER)
    elif not enabled:
        return False
    else:
        doc = frappe.new_doc("Social Login Key")
        doc.social_login_provider = "Keycloak"
        doc.provider_name = "Keycloak"

    if not enabled:
        if doc.enable_social_login:
            doc.enable_social_login = 0
            doc.save(ignore_permissions=True)
            say("sign-in through the realm is switched off")
        return False

    doc.update(
        {
            "enable_social_login": 1,
            "custom_base_url": 1,
            "base_url": issuer,
            "authorize_url": "/protocol/openid-connect/auth",
            "access_token_url": "/protocol/openid-connect/token",
            "api_endpoint": "/protocol/openid-connect/userinfo",
            "redirect_url": "/api/method/frappe.integrations.oauth2_logins.login_via_keycloak",
            "user_id_property": os.environ.get("OIDC_USER_ID_CLAIM") or "sub",
            "auth_url_data": json.dumps(
                {"response_type": "code", "scope": os.environ.get("OIDC_SCOPE") or "openid email profile"}
            ),
            # A person the realm admits gets an account at the first sign-in.
            "sign_ups": "Allow",
            "client_id": client_id,
            "client_secret": client_secret,
        }
    )
    doc.save(ignore_permissions=True)
    say("sign-in through %s as client %s" % (issuer, client_id))
    return True


def settings(realm_sign_in):
    # Nobody registers on the website: people come from the realm.
    frappe.db.set_single_value("Website Settings", "disable_signup", 1)

    # Frappe refuses to switch the password form off while no other way in exists.
    password_login = os.environ.get("SIGN_IN_PASSWORD_LOGIN") == "true" or not realm_sign_in
    frappe.db.set_single_value("System Settings", "disable_user_pass_login", 0 if password_login else 1)
    say("password sign-in is %s" % ("on" if password_login else "off"))

    role = os.environ.get("SIGN_IN_DEFAULT_ROLE", "")
    if role and not frappe.db.exists("Role", role):
        say("the role %r does not exist; new accounts get none" % role)
        role = ""
    frappe.db.set_single_value("Portal Settings", "default_role", role or None)


def administrator_api_key():
    key = os.environ.get("ADMIN_API_KEY", "")
    secret = os.environ.get("ADMIN_API_SECRET", "")
    if not key or not secret:
        return
    frappe.db.set_value("User", "Administrator", "api_key", key, update_modified=False)
    set_encrypted_password("User", "Administrator", secret, "api_secret")


def company_abbr(name):
    """ERPNext's own rule: the initials, or the first letters of a single word."""
    words = [w for w in name.replace("-", " ").split() if w[:1].isalnum()]
    abbr = "".join(w[0] for w in words) if len(words) > 1 else name[:5]
    return abbr.upper()[:10] or "CO"


def organization():
    """Who the tenant is, from the values; {} when the platform said nothing."""
    try:
        with open("/gentian/organization.json") as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def setup_from_organization():
    """Runs the setup wizard from who the tenant is, once.

    Frappe's desk shows its wizard until the site is set up; the first System
    Manager would be asked for the company, country, currency and fiscal year.
    The platform knows them, so the site is set up from them instead. Never
    over a site that is already set up: its company, currency and chart of
    accounts are the tenant's data by then.
    """
    if frappe.is_setup_complete():
        return
    org = organization()
    if not org.get("complete"):
        say("the tenant's settings are incomplete; the setup wizard is left to the first System Manager")
        return

    country = frappe.db.get_value("Country", {"code": org["country"].lower()}, "name")
    if not country:
        say("Frappe knows no country %r; the setup wizard is left to the first System Manager" % org["country"])
        return
    language_code = (org.get("languages") or ["en"])[0]
    language = frappe.db.get_value("Language", language_code, "language_name") or "English"

    # ERPNext's generic chart, unless the values name another. Its country
    # charts are no safe default: Switzerland's only one is a school's, and
    # Germany and France offer several to choose between.
    chart = os.environ.get("CHART_OF_ACCOUNTS") or "Standard"

    today = datetime.date.today()
    month = int(org.get("fiscalYearStartMonth") or 1)
    start = datetime.date(today.year if today.month >= month else today.year - 1, month, 1)
    end = datetime.date(start.year + 1, start.month, 1) - datetime.timedelta(days=1)

    name = org.get("legalName") or org.get("displayName")
    args = {
        "language": language,
        "country": country,
        "timezone": org.get("timeZone"),
        "currency": org.get("currency"),
        "company_name": name,
        "company_abbr": company_abbr(name),
        "chart_of_accounts": chart,
        "fy_start_date": start.isoformat(),
        "fy_end_date": end.isoformat(),
        "enable_telemetry": 0,
    }
    from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

    result = setup_complete(args)
    if not frappe.is_setup_complete():
        say("the setup wizard did not finish (%s); it is left to the first System Manager" % result)
        return
    company_details(name, org)
    say("set up as %s (%s, %s, %s)" % (name, country, org.get("currency"), chart))


def company_details(name, org):
    """What the wizard does not ask: the company's numbers, contact and address."""
    company = frappe.get_doc("Company", name)
    registration = org.get("registrationNumber")
    company.update(
        {
            "tax_id": org.get("taxId") or company.tax_id,
            "email": org.get("email") or company.email,
            "phone_no": org.get("phone") or company.phone_no,
            "website": org.get("website") or company.website,
            "registration_details": ("Commercial register: %s" % registration) if registration else company.registration_details,
        }
    )
    company.save(ignore_permissions=True)

    address = org.get("address") or {}
    if not (address.get("street") and address.get("city")):
        return
    doc = frappe.new_doc("Address")
    doc.update(
        {
            "address_title": name,
            "address_type": "Billing",
            "address_line1": address["street"].splitlines()[0],
            "address_line2": "\n".join(address["street"].splitlines()[1:]) or None,
            "pincode": address.get("postalCode"),
            "city": address["city"],
            "state": address.get("region"),
            "country": company.country,
            "email_id": org.get("email") or None,
            "phone": org.get("phone") or None,
            "is_your_company_address": 1,
            "is_primary_address": 1,
        }
    )
    doc.append("links", {"link_doctype": "Company", "link_name": name})
    doc.insert(ignore_permissions=True)


def main():
    frappe.init(site=SITE, sites_path="/home/frappe/frappe-bench/sites")
    frappe.connect()
    try:
        frappe.set_user("Administrator")
        realm_sign_in = social_login_key()
        settings(realm_sign_in)
        administrator_api_key()
        frappe.db.commit()
        setup_from_organization()
        frappe.db.commit()
        frappe.clear_cache()
    finally:
        frappe.destroy()


if __name__ == "__main__":
    main()
