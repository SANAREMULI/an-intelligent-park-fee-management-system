-- =====================================================================
-- superdata
-- Intelligent Park Fee Management System — Sekenani Gate, Maasai Mara
-- MySQL 8 / MariaDB schema — built for XAMPP (import via phpMyAdmin
-- or `mysql -u root -p < superdata.sql`)
--
-- Every table and value here is parity-matched to the pricing and
-- booking engine in assets/js/app.js — same category rates, same
-- season window, same surcharge rules, same holiday list, same
-- membership plans, same staff accounts (salt+SHA-256 hashes copied
-- verbatim from STAFF_USERS so a PHP auth layer can check against
-- either side without re-hashing anything).
-- =====================================================================

DROP DATABASE IF EXISTS superdata;
CREATE DATABASE superdata CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE superdata;

-- ---------------------------------------------------------------------
-- REFERENCE / LOOKUP TABLES — mirror the JS constants exactly
-- ---------------------------------------------------------------------

CREATE TABLE fee_categories (
  code        VARCHAR(20)  PRIMARY KEY,      -- kenyan | ea | nonresident
  label       VARCHAR(60)  NOT NULL,
  adult_rate  DECIMAL(10,2) NOT NULL,        -- KSh per adult per day
  child_rate  DECIMAL(10,2) NOT NULL         -- KSh per child per day
) ENGINE=InnoDB;

INSERT INTO fee_categories (code, label, adult_rate, child_rate) VALUES
('kenyan',      'Kenyan Citizen',         1500.00,  500.00),
('ea',          'East African Resident',  3000.00, 1000.00),
('nonresident', 'Non-Resident',           9000.00, 4500.00);

CREATE TABLE vehicle_fee (
  id   TINYINT PRIMARY KEY DEFAULT 1,
  fee  DECIMAL(10,2) NOT NULL                -- per vehicle per day, all categories, never waived
) ENGINE=InnoDB;

INSERT INTO vehicle_fee (id, fee) VALUES (1, 500.00);

CREATE TABLE seasons (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  from_mmdd   CHAR(5) NOT NULL,               -- 'MM-DD', inclusive
  to_mmdd     CHAR(5) NOT NULL,                -- 'MM-DD', inclusive
  multiplier  DECIMAL(4,2) NOT NULL            -- applies to person fees only
) ENGINE=InnoDB;

INSERT INTO seasons (name, from_mmdd, to_mmdd, multiplier) VALUES
('Peak Season (Migration)', '07-01', '10-31', 1.50);

CREATE TABLE surcharges (
  kind  VARCHAR(20) PRIMARY KEY,               -- weekend | holiday
  pct   DECIMAL(4,2) NOT NULL                  -- 0.10 = +10%
) ENGINE=InnoDB;

INSERT INTO surcharges (kind, pct) VALUES
('weekend', 0.10),
('holiday', 0.20);

-- When a day is both a weekend and a holiday, the HIGHER surcharge
-- applies (they do not stack) — enforced in fn_day_rate() below.

CREATE TABLE holidays (
  holiday_date DATE PRIMARY KEY,
  name         VARCHAR(80) NOT NULL
) ENGINE=InnoDB;

INSERT INTO holidays (holiday_date, name) VALUES
('2026-01-01', "New Year's Day"),
('2026-03-20', 'Idd-ul-Fitr'),
('2026-04-03', 'Good Friday'),
('2026-04-06', 'Easter Monday'),
('2026-05-01', 'Labour Day'),
('2026-05-27', 'Idd-ul-Adha'),
('2026-06-01', 'Madaraka Day'),
('2026-10-10', 'Mazingira Day'),
('2026-10-20', 'Mashujaa Day'),
('2026-12-12', 'Jamhuri Day'),
('2026-12-25', 'Christmas Day'),
('2026-12-26', 'Boxing Day'),
('2027-01-01', "New Year's Day");
-- Idd dates depend on moon sighting — update this table when gazetted;
-- the app previously said "update via Settings/DB", this table is that DB.

CREATE TABLE membership_plans (
  id                VARCHAR(20) PRIMARY KEY,    -- ANNUAL-IND, ANNUAL-FAM, EA-ANNUAL, TOUR-OP
  name              VARCHAR(80) NOT NULL,
  category          VARCHAR(20) NOT NULL,       -- kenyan | ea | any
  price             DECIMAL(10,2) NOT NULL,
  months            INT NOT NULL,
  adults_covered    INT NOT NULL,
  children_covered  INT NOT NULL,
  blurb             VARCHAR(200)
) ENGINE=InnoDB;

INSERT INTO membership_plans (id, name, category, price, months, adults_covered, children_covered, blurb) VALUES
('ANNUAL-IND', 'Annual Pass — Individual',   'kenyan', 15000.00,  12, 1, 0, 'Unlimited entry for one Kenyan citizen adult for 12 months.'),
('ANNUAL-FAM', 'Annual Pass — Family',       'kenyan', 40000.00,  12, 2, 3, 'Unlimited entry for 2 adults and up to 3 children (Kenyan citizens).'),
('EA-ANNUAL',  'Annual Pass — EA Resident',  'ea',     60000.00,  12, 1, 0, 'Unlimited entry for one East African resident adult for 12 months.'),
('TOUR-OP',    'Tour Operator Pass',         'any',   250000.00,  12, 4, 0, 'For licensed operators — covers up to 4 guests per visit, any category.');

-- ---------------------------------------------------------------------
-- ACCOUNTS
-- ---------------------------------------------------------------------

CREATE TABLE staff_users (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  email  VARCHAR(120) UNIQUE NOT NULL,
  name   VARCHAR(120) NOT NULL,
  role   VARCHAR(60)  NOT NULL,
  salt   VARCHAR(32)  NOT NULL,
  hash   VARCHAR(64)  NOT NULL,      -- SHA-256(salt+password). Demo-grade —
                                      -- production should re-hash server-side with bcrypt/argon2.
  tabs   JSON NOT NULL               -- admin console tabs this role may open
) ENGINE=InnoDB;

INSERT INTO staff_users (email, name, role, salt, hash, tabs) VALUES
('admin@pfms.go.ke',   'John Sanare',     'System Administrator', 'a3f19c02d7e845b1', '8563e9f81377b4f6031ee0dec5e843fe5ce50e5e60e0f2c8306cf9c9cab52675', JSON_ARRAY('overview','tickets','revenue','members','settings','audit')),
('ranger@pfms.go.ke',  'Naserian Sopia',  'Gate Ranger',           '5c8e2b91f0a4d367', 'd481e12281893c34db0bb0f55479072e3705c26741b46874215914b30003b827', JSON_ARRAY('overview','tickets')),
('finance@pfms.go.ke', 'Kipchoge Rotich', 'Finance Officer',       '9d47e1c3b28f0a56', 'd2584101f203c7bc44888a52c4fd0c00b863e67030be4f34889735f95378c9c9', JSON_ARRAY('overview','revenue','members'));

CREATE TABLE visitors (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  email          VARCHAR(120) UNIQUE NOT NULL,
  name           VARCHAR(120) NOT NULL,
  phone          VARCHAR(20),
  salt           VARCHAR(32) NOT NULL,
  hash           VARCHAR(64) NOT NULL,
  registered_at  DATETIME NOT NULL,
  last_login_at  DATETIME
) ENGINE=InnoDB;

CREATE TABLE login_lockouts (
  email         VARCHAR(120) PRIMARY KEY,
  fail_count    INT NOT NULL DEFAULT 0,
  locked_until  DATETIME NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- BOOKINGS, MEMBERSHIPS, FEEDBACK, AUDIT
-- ---------------------------------------------------------------------

-- Persistent counters — same mechanism as nextRef()/memberNoNext() in
-- app.js (an incrementing counter, not derived from row id). A STORED
-- generated column can't reference an AUTO_INCREMENT column in
-- MySQL/MariaDB, so refs are assigned by trigger from this table instead.
CREATE TABLE ref_counters (
  name   VARCHAR(30) PRIMARY KEY,
  value  INT NOT NULL
) ENGINE=InnoDB;

INSERT INTO ref_counters (name, value) VALUES
('booking_ref', 900000),   -- first booking -> PFMS-2026-900001
('member_no', 100);        -- first membership -> MMP-2026-0101

CREATE TABLE bookings (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  ref               VARCHAR(20) UNIQUE,
  user_email        VARCHAR(120) NOT NULL,
  visitor_name      VARCHAR(120) NOT NULL,
  email             VARCHAR(120),
  phone             VARCHAR(20),
  id_no             VARCHAR(40),
  category          VARCHAR(20) NOT NULL,
  category_label    VARCHAR(60) NOT NULL,
  visit_date        DATE NOT NULL,
  days              INT NOT NULL DEFAULT 1,
  adults            INT NOT NULL DEFAULT 1,
  children          INT NOT NULL DEFAULT 0,
  vehicle_plate     VARCHAR(20),
  total_amount      DECIMAL(10,2) NOT NULL,
  member_saved      DECIMAL(10,2) NOT NULL DEFAULT 0,
  member_plan_name  VARCHAR(80),
  pay_method        VARCHAR(30) NOT NULL,        -- M-Pesa | Airtel Money | Card | Cash at Gate | Annual Pass
  receipt_no        VARCHAR(30),
  status            ENUM('Reserved','Paid') NOT NULL DEFAULT 'Reserved',
  paid_at           DATETIME,
  checked_in        BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at     DATETIME,
  booked_at         DATETIME NOT NULL,
  is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (category) REFERENCES fee_categories(code),
  INDEX idx_bookings_visit_date (visit_date),
  INDEX idx_bookings_booked_at (booked_at),
  INDEX idx_bookings_user_email (user_email)
) ENGINE=InnoDB;

CREATE TABLE memberships (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  member_no     VARCHAR(20) UNIQUE,
  email         VARCHAR(120) NOT NULL,
  holder_name   VARCHAR(120) NOT NULL,
  plan_id       VARCHAR(20) NOT NULL,
  plan_name     VARCHAR(80) NOT NULL,
  price         DECIMAL(10,2) NOT NULL,
  pay_method    VARCHAR(30) NOT NULL,
  receipt_no    VARCHAR(30),
  purchased_at  DATETIME NOT NULL,
  expires_at    DATETIME NOT NULL,
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (plan_id) REFERENCES membership_plans(id),
  INDEX idx_memberships_email (email),
  INDEX idx_memberships_expires (expires_at)
) ENGINE=InnoDB;

CREATE TABLE feedback (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  rating        TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  visitor_name  VARCHAR(120),
  visit_date    DATE,
  ref           VARCHAR(20),
  category      VARCHAR(20),
  comment       TEXT,
  submitted_at  DATETIME NOT NULL,
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  action       VARCHAR(200) NOT NULL,
  actor_name   VARCHAR(120),
  actor_email  VARCHAR(120),
  actor_role   VARCHAR(60),
  logged_at    DATETIME NOT NULL,
  INDEX idx_audit_logged_at (logged_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- REF / MEMBER NUMBER GENERATION — mirrors nextRef() / memberNoNext()
-- ---------------------------------------------------------------------

DELIMITER $$

CREATE TRIGGER trg_bookings_ref BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  DECLARE v_next INT;
  IF NEW.ref IS NULL THEN
    UPDATE ref_counters SET value = value + 1 WHERE name = 'booking_ref';
    SELECT value INTO v_next FROM ref_counters WHERE name = 'booking_ref';
    SET NEW.ref = CONCAT('PFMS-2026-', LPAD(v_next, 6, '0'));
  END IF;
END$$

CREATE TRIGGER trg_memberships_no BEFORE INSERT ON memberships
FOR EACH ROW
BEGIN
  DECLARE v_next INT;
  IF NEW.member_no IS NULL THEN
    UPDATE ref_counters SET value = value + 1 WHERE name = 'member_no';
    SELECT value INTO v_next FROM ref_counters WHERE name = 'member_no';
    SET NEW.member_no = CONCAT('MMP-2026-', LPAD(v_next, 4, '0'));
  END IF;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- PRICING ENGINE — SQL equivalent of classifyDay() / quoteBooking()
-- in assets/js/app.js, so the same fee logic can run server-side.
-- ---------------------------------------------------------------------

DELIMITER $$

-- Rate for ONE person, for ONE day: base rate x season multiplier x (1+surcharge).
-- Holiday and weekend surcharges never stack — the higher one wins, matching
-- classifyDay() in app.js.
CREATE FUNCTION fn_day_rate(p_category VARCHAR(20), p_date DATE, p_is_adult BOOLEAN)
RETURNS DECIMAL(10,2)
DETERMINISTIC
READS SQL DATA
BEGIN
  DECLARE v_base DECIMAL(10,2);
  DECLARE v_mult DECIMAL(4,2) DEFAULT 1.00;
  DECLARE v_sur  DECIMAL(4,2) DEFAULT 0.00;
  DECLARE v_weekend_pct DECIMAL(4,2);
  DECLARE v_holiday_pct DECIMAL(4,2);
  DECLARE v_is_holiday  BOOLEAN;
  DECLARE v_is_weekend  BOOLEAN;

  IF p_is_adult THEN
    SELECT adult_rate INTO v_base FROM fee_categories WHERE code = p_category;
  ELSE
    SELECT child_rate INTO v_base FROM fee_categories WHERE code = p_category;
  END IF;

  SET v_is_weekend = (DAYOFWEEK(p_date) IN (1,7));               -- 1=Sun, 7=Sat
  SET v_is_holiday = EXISTS(SELECT 1 FROM holidays WHERE holiday_date = p_date);

  SELECT COALESCE(MAX(multiplier), 1.00) INTO v_mult FROM seasons
   WHERE DATE_FORMAT(p_date, '%m-%d') BETWEEN from_mmdd AND to_mmdd;

  SELECT pct INTO v_weekend_pct FROM surcharges WHERE kind = 'weekend';
  SELECT pct INTO v_holiday_pct FROM surcharges WHERE kind = 'holiday';

  IF v_is_holiday AND v_holiday_pct >= IF(v_is_weekend, v_weekend_pct, 0) THEN
    SET v_sur = v_holiday_pct;
  ELSEIF v_is_weekend THEN
    SET v_sur = v_weekend_pct;
  END IF;

  RETURN ROUND(v_base * v_mult * (1 + v_sur), 2);
END$$

-- Full stay quote: sums fn_day_rate() across every day of the visit, plus
-- the flat vehicle fee. Pass already membership-reduced adult/child counts
-- (i.e. quoteBooking()'s payAdults/payChildren) to keep parity with the
-- front end — this function does not itself look up membership coverage.
CREATE FUNCTION fn_quote_total(
  p_category  VARCHAR(20),
  p_start     DATE,
  p_days      INT,
  p_adults    INT,
  p_children  INT,
  p_vehicle   BOOLEAN
)
RETURNS DECIMAL(10,2)
DETERMINISTIC
READS SQL DATA
BEGIN
  DECLARE v_total  DECIMAL(10,2) DEFAULT 0;
  DECLARE v_veh    DECIMAL(10,2);
  DECLARE i        INT DEFAULT 0;
  DECLARE v_d      DATE;

  SELECT fee INTO v_veh FROM vehicle_fee WHERE id = 1;

  WHILE i < p_days DO
    SET v_d = DATE_ADD(p_start, INTERVAL i DAY);
    SET v_total = v_total
      + p_adults   * fn_day_rate(p_category, v_d, TRUE)
      + p_children * fn_day_rate(p_category, v_d, FALSE)
      + IF(p_vehicle, v_veh, 0);
    SET i = i + 1;
  END WHILE;

  RETURN v_total;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- ANALYTICS VIEWS — back the admin revenue dashboard
-- ---------------------------------------------------------------------

CREATE VIEW v_daily_revenue AS
SELECT visit_date,
       COUNT(*)                                   AS bookings,
       SUM(total_amount)                          AS revenue,
       SUM(CASE WHEN status='Paid' THEN 1 ELSE 0 END) AS paid_bookings
FROM bookings
GROUP BY visit_date
ORDER BY visit_date;

CREATE VIEW v_active_memberships AS
SELECT * FROM memberships WHERE expires_at > NOW();

CREATE VIEW v_gate_checkins_today AS
SELECT ref, visitor_name, category_label, checked_in_at
FROM bookings
WHERE checked_in = TRUE AND DATE(checked_in_at) = CURDATE();

-- =====================================================================
-- End of schema. No demo bookings/memberships/feedback are seeded here —
-- that data is generated at runtime by the app's "Seed Demo Data" admin
-- action, same as it works against localStorage today.
-- =====================================================================
