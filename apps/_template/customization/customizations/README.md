# Customization records

One YAML file per deviation this app itself carries, at rung **L2 or above**. Written
*before* the code — the record is the design review.

Schema: `Customization` (`gentianos.io/v1alpha1`). See
[gentian-os/docs/app-customization.md §5](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

Required for every record: the chosen rung and scope, a justification for **every**
cheaper rung skipped, the upstream-first outcome, a named owner, a review date, and
exit criteria.

Validate with `python3 scripts/validate-customizations.py` in `gentian-apps`.
