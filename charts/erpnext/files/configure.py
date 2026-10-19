"""Sign-in and the settings that go with it, written into the site from this pod's values.

Run by configure.sh on every start, so that what the values say is what the site
does: a changed client secret, a realm moved to another host, a restore from
another domain all take effect at the next start.
"""

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


def main():
    frappe.init(site=SITE, sites_path="/home/frappe/frappe-bench/sites")
    frappe.connect()
    try:
        frappe.set_user("Administrator")
        realm_sign_in = social_login_key()
        settings(realm_sign_in)
        administrator_api_key()
        frappe.db.commit()
        frappe.clear_cache()
    finally:
        frappe.destroy()


if __name__ == "__main__":
    main()
