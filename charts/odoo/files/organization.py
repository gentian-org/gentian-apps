# Who the tenant is, written onto Odoo's company once (odoo-bin shell; env is
# Odoo's). Odoo makes a placeholder company, "My Company", when it creates a
# database and asks nobody; this gives it the tenant's name, country,
# currency, address and numbers instead, and the tenant's language and time
# zone to the accounts that exist and as the default of new ones.
#
# Once: a company the tenant has since edited is its data. A database that
# was set up from a complete organization records it, and is never touched
# again; an incomplete one is left as Odoo made it until a start finds the
# organization complete.
import json

DONE = "gentian.organization_applied"


def say(message):
    print("odoo-organization: " + message, flush=True)


def apply(env, org):
    icp = env["ir.config_parameter"].sudo()
    if icp.get_param(DONE):
        return
    if not org.get("complete"):
        say("the tenant's settings are incomplete; the company is left as it is")
        return

    company = env.ref("base.main_company")
    country = env["res.country"].search([("code", "=", org["country"].upper())], limit=1)
    currency = env["res.currency"].with_context(active_test=False).search([("name", "=", org["currency"])], limit=1)
    if currency and not currency.active:
        currency.active = True
    address = org.get("address") or {}
    street = (address.get("street") or "").splitlines()
    state = env["res.country.state"]
    if country and address.get("region"):
        state = state.search(
            [("country_id", "=", country.id), "|", ("code", "=ilike", address["region"]), ("name", "=ilike", address["region"])],
            limit=1,
        )

    values = {
        "name": org.get("legalName") or org.get("displayName") or company.name,
        "street": street[0] if street else False,
        "street2": "\n".join(street[1:]) or False,
        "zip": address.get("postalCode") or False,
        "city": address.get("city") or False,
        "state_id": state.id or False,
        "country_id": country.id or False,
        "website": org.get("website") or False,
        "email": org.get("email") or False,
        "phone": org.get("phone") or False,
        "vat": org.get("taxId") or False,
        "company_registry": org.get("registrationNumber") or False,
    }
    if currency:
        values["currency_id"] = currency.id
    # With accounting installed: the last day of the fiscal year.
    if "fiscalyear_last_month" in company._fields:
        last = (int(org.get("fiscalYearStartMonth") or 1) + 10) % 12 + 1
        values["fiscalyear_last_month"] = str(last)
        values["fiscalyear_last_day"] = 31 if last in (1, 3, 5, 7, 8, 10, 12) else (28 if last == 2 else 30)
    company.write({k: v for k, v in values.items() if k in company._fields})

    lang = language(env, (org.get("languages") or ["en"])[0], org["country"])
    people = {"tz": org.get("timeZone") or False}
    if lang:
        people["lang"] = lang
    env["res.users"].with_context(active_test=False).search([("share", "=", False)]).write(people)
    company.partner_id.write({k: v for k, v in people.items() if k == "lang"})
    # An account made at its first sign-in is a new partner: these are what
    # it starts with.
    for field, value in people.items():
        if value:
            env["ir.default"].set("res.partner", field, value)

    icp.set_param(DONE, "1")
    say("company set up as %s (%s, %s%s)" % (values["name"], org["country"], org["currency"], ", " + lang if lang else ""))


def language(env, code, country):
    """The tenant's language as an Odoo one, its translations loaded: the
    country's variant where Odoo has one (de_CH), else the language's own."""
    Lang = env["res.lang"].with_context(active_test=False)
    lang = Lang.search([("code", "=", "%s_%s" % (code, country.upper()))], limit=1) or Lang.search(
        [("iso_code", "=", code)], limit=1
    )
    if not lang:
        return None
    if not lang.active:
        env["base.language.install"].create({"lang_ids": [(6, 0, lang.ids)], "overwrite": False}).lang_install()
    return lang.code


with open("/etc/gentian/organization.json") as f:
    apply(env, json.load(f) or {})  # noqa: F821 -- odoo-bin shell's
env.cr.commit()  # noqa: F821
