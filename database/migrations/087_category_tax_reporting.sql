ALTER TABLE categories ADD COLUMN is_tax_related BOOLEAN DEFAULT false;
ALTER TABLE categories ADD COLUMN tax_line_item VARCHAR(255) DEFAULT NULL;

-- Backfill existing categories
UPDATE categories 
SET is_tax_related = true,
    tax_line_item = CASE 
        WHEN LOWER(name) LIKE '%medical%' OR LOWER(name) LIKE '%health%' OR LOWER(name) LIKE '%dental%' OR LOWER(name) LIKE '%vision%' OR LOWER(name) LIKE '%prescription%' OR LOWER(name) LIKE '%pharmacy%' THEN 'Schedule A: Medical & Dental'
        WHEN LOWER(name) LIKE '%donation%' OR LOWER(name) LIKE '%charity%' OR LOWER(name) LIKE '%charitable%' THEN 'Schedule A: Cash Contributions'
        WHEN LOWER(name) LIKE '%tax%' OR LOWER(name) LIKE '%property tax%' THEN 'Schedule A: Taxes Paid'
        WHEN LOWER(name) LIKE '%education%' OR LOWER(name) LIKE '%tuition%' OR LOWER(name) LIKE '%school%' OR LOWER(name) LIKE '%course%' OR LOWER(name) LIKE '%training%' THEN 'Form 1040: Education Expenses'
        WHEN LOWER(name) LIKE '%childcare%' OR LOWER(name) LIKE '%daycare%' THEN 'Form 2441: Child Care Expenses'
        WHEN LOWER(name) LIKE '%union%' OR LOWER(name) LIKE '%professional dues%' THEN 'Schedule A: Job Expenses'
        WHEN LOWER(name) LIKE '%retirement%' OR LOWER(name) LIKE '%rrsp%' OR LOWER(name) LIKE '%401k%' OR LOWER(name) LIKE '%ira%' THEN 'Form 1040: Retirement Contributions'
        ELSE 'Schedule A: Miscellaneous Deductions'
    END
WHERE 
    LOWER(name) LIKE '%medical%' OR LOWER(name) LIKE '%health%' OR LOWER(name) LIKE '%dental%' OR LOWER(name) LIKE '%vision%' OR LOWER(name) LIKE '%prescription%' OR LOWER(name) LIKE '%pharmacy%'
    OR LOWER(name) LIKE '%donation%' OR LOWER(name) LIKE '%charity%' OR LOWER(name) LIKE '%charitable%'
    OR LOWER(name) LIKE '%education%' OR LOWER(name) LIKE '%tuition%' OR LOWER(name) LIKE '%school%' OR LOWER(name) LIKE '%course%' OR LOWER(name) LIKE '%training%'
    OR LOWER(name) LIKE '%childcare%' OR LOWER(name) LIKE '%daycare%'
    OR LOWER(name) LIKE '%union%' OR LOWER(name) LIKE '%professional dues%'
    OR LOWER(name) LIKE '%rrsp%' OR LOWER(name) LIKE '%retirement%';
