# Odoo Community (OCB) Module Wishlist

This document lists the recommended **Odoo Community Association (OCA)** modules that are highly beneficial for running a bar or restaurant environment but have not yet been packaged as Gentian OS AppProfiles.

---

## 1. Point of Sale (POS) & Payment

### pos_payment_terminal
* **Description:** Integrates the Odoo Point of Sale interface with physical card payment terminals (EFTPOS, SumUp, Adyen, etc.).
* **Operational Benefit:** Prevents manual data entry errors by automatically sending the transaction amount to the physical reader and recording the success/failure state in Odoo.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

### pos_session_pay_invoice
* **Description:** Allows cashiers to process payments for open customer tabs or invoices directly from the POS interface rather than going through the standard backend accounting menus.
* **Operational Benefit:** Enables customers to settle pre-existing tabs or event invoices quickly at the main bar counter.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

---

## 2. Cash Management & Security

### pos_cash_control_override
* **Description:** Bypasses Odoo's restriction requiring elevated accounting permissions (Billing/Accounting manager) to perform simple "Cash In" and "Cash Out" operations in the POS.
* **Operational Benefit:** Allows managers and bartenders to perform standard drawer operations (like payout of tips or mid-shift cash drops) without granting them full access to the backend accounting journals.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

### pos_cash_control_extension
* **Description:** Enforces strict balance declarations and cash counts when opening and closing POS sessions.
* **Operational Benefit:** Ensures high drawer accuracy across shift changes by forcing bartenders to count the physical cash and highlighting discrepancies before a session can be successfully closed.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

### pos_user_restriction
* **Description:** Restricts POS cashiers/users to only open and use specific Point of Sale configurations.
* **Operational Benefit:** Prevents staff members from accessing or opening sessions on cash registers outside of their assigned service zones (e.g., preventing patio staff from using the main indoor bar terminal).
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

---

## 3. UI & Operational Efficiency

### pos_order_remove_line
* **Description:** Adds a clear, simple button to remove a line item from the active cart in the POS.
* **Operational Benefit:** Simplifies UI interaction for bartenders during fast-paced service compared to setting item quantity to zero.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

### pos_margin
* **Description:** Displays the gross margin of the active ticket and individual items on the POS screen or backend orders.
* **Operational Benefit:** Allows supervisors to immediately gauge the profitability of order compositions or custom drink request pricing.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)

---

## 4. Multi-Entity Operations

### pos_restaurant_multi_company
* **Description:** Adds multi-company validation to restaurant floors and tables.
* **Operational Benefit:** Useful if the bar operates under a different legal entity or shared space compared to adjacent operations (e.g., a hotel lobby bar sharing seating with a separate dining company), ensuring floor plans are isolated to the correct business context.
* **Technical Repo:** [OCA/pos](https://github.com/OCA/pos)
