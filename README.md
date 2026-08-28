# An Intelligent Park Fee Management System — Sekenani Gate

A booking, ticketing, membership, and admin platform for the Maasai Mara
(Sekenani Gate) park fee system. Handles date-aware fee calculation
(peak season, weekends, public holidays), M-Pesa / Airtel Money / card
payment flows, annual membership passes, gate ticket verification, and
a live revenue/analytics dashboard for staff.

## 🔗 Live demo

[**Open the app in your browser**](https://sanaremuli.github.io/an-intelligent-park-fee-management-system/)

Hosted on GitHub Pages — it redeploys automatically on every push to `main`, so this link always reflects the current code. (If it 404s, GitHub Pages needs to be turned on once, under repo Settings → Pages → Deploy from branch `main` / root.)

## Project structure

```
.
├── index.html      # entry point — self-contained: HTML, CSS, and JS all in one file
├── superdata.sql   # MySQL/MariaDB schema — import into XAMPP
└── README.md
```

## Running the front end

The app is fully client-side today — `index.html` works by itself in any
browser, no server required. Data is kept in `localStorage` under the
`pfms_*` keys (bookings, memberships, feedback, users, audit log).

Demo staff logins (see `index.html` → `STAFF_USERS`):

| Email | Role |
|---|---|
| admin@pfms.go.ke | System Administrator |
| ranger@pfms.go.ke | Gate Ranger |
| finance@pfms.go.ke | Finance Officer |

(Passwords are the ones already agreed for the demo — not stored in this repo in plaintext; only salted SHA-256 hashes are, both in `index.html` and in `superdata.sql`.)

## The database — `superdata`

`superdata.sql` is a full MySQL/MariaDB schema, **built and test-imported against a live MariaDB 10.11 instance** before being added to this repo — every table, trigger, and function in it actually runs, not just parses.

**Import it in XAMPP:**

1. Start Apache + MySQL from the XAMPP control panel.
2. Open `http://localhost/phpmyadmin`.
3. Click **Import** → choose `superdata.sql` → **Go**.
(It runs `DROP DATABASE IF EXISTS superdata; CREATE DATABASE superdata;`   at the top, so it's safe to re-import from scratch at any point.)

Or from a terminal with `mysql` on your PATH:

```bash
mysql -u root -p < superdata.sql
```

**What's in it:**

- **Reference tables** — `fee_categories`, `vehicle_fee`, `seasons`, `surcharges`, `holidays`, `membership_plans` — mirror the constants in `index.html` (`BASE_RATES`, `SEASONS`, `SURCHARGES`, `HOLIDAYS`, `MEMBER_PLANS`) exactly, so both sides agree on rates.
- **Accounts** — `staff_users`, `visitors`, `login_lockouts`. Staff salts/hashes are copied verbatim from `STAFF_USERS` in `index.html`.
- **Transactional tables** — `bookings`, `memberships`, `feedback`,
  `audit_log`, each matching the shape of the objects the JS app already
  writes to `localStorage`.
- **`fn_day_rate(category, date, is_adult)`** — SQL port of
  `classifyDay()`: applies the peak-season multiplier, then the weekend
  or holiday surcharge (never both — the higher one wins, same rule as
  the JS).
- **`fn_quote_total(category, start_date, days, adults, children,
  vehicle)`** — SQL port of `quoteBooking()`: sums `fn_day_rate()` across
  the stay plus the flat vehicle fee. Pass it membership-reduced
  adult/child counts to match the front end's logic exactly — it doesn't
  look up membership coverage itself.
- **Triggers** `trg_bookings_ref` / `trg_memberships_no` — assign `PFMS-2026-NNNNNN` / `MMP-2026-NNNN` reference numbers from a counter table, the same incrementing-counter approach `nextRef()` / `memberNoNext()` use in `index.html` (not derived from the row ID — MySQL doesn't allow that for generated columns, which is exactly the bug this design avoids).
- **Views** `v_daily_revenue`, `v_active_memberships`,
  `v_gate_checkins_today` — ready-made queries for the admin dashboard.

**What it does not do yet:** the running app still reads and writes `localStorage`, not this database. Wiring the front end to real endpoints (PHP + PDO against `superdata`, or any other backend) is a separate, deliberately not-yet-built step — say the word and I'll build that layer next.

## Pricing logic, in one paragraph

Every day of a stay is classified once: is it in the peak migration
window (Jul 1–Oct 31, ×1.5 on person fees)? Is it a weekend or a gazetted
public holiday? If both, the holiday surcharge (+20%) wins over the
weekend one (+10%) — they never stack. Vehicle fees (KSh 500/day) are
flat and never waived, even under an annual pass. Annual passes cover a
fixed number of adults/children per visit; anyone beyond that pays the
normal rate.
