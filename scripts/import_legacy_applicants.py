import json
import math
import re
import warnings

import pandas as pd

warnings.simplefilter("ignore", UserWarning)


SOURCE = r"C:\\Users\\Matt\\Desktop\\Job Application (Responses) 081626.xlsx"


def clean(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value).strip()


def sql(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def iso_datetime(value):
    if value is None:
        return None
    parsed = pd.to_datetime(value, errors="coerce")
    return None if pd.isna(parsed) else parsed.isoformat()


def iso_date(value):
    if value is None:
        return None
    parsed = pd.to_datetime(value, errors="coerce", dayfirst=True)
    return None if pd.isna(parsed) else parsed.date().isoformat()


def numeric_rate(value):
    if not value:
        return None
    match = re.fullmatch(r"\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:/hour|an hour|per hour)?\s*", value, re.I)
    return float(match.group(1)) if match else None


def yes_no(value):
    if not value:
        return None
    normalized = value.lower()
    if normalized.startswith("yes"):
        return True
    if normalized.startswith("no"):
        return False
    return None


def main():
    dataframe = pd.read_excel(SOURCE)
    columns = list(dataframe.columns)
    rows = []

    for _, row in dataframe.iterrows():
        raw = {
            columns[index]: clean(row.iloc[index])
            for index in range(len(columns))
            if not str(columns[index]).startswith("Column 18")
        }
        email = (clean(row.iloc[4]) or clean(row.iloc[1]) or "").lower()
        if not email:
            continue

        received = iso_datetime(clean(row.iloc[0]))
        rate_text = clean(row.iloc[9])
        values = [
            "(select id from public.organizations where name = 'Soro Group' limit 1)",
            sql(clean(row.iloc[3])),
            sql(email),
            sql(clean(row.iloc[6])),
            "null",
            "null",
            "'submitted'::public.applicant_status",
            "null",
            sql(received),
            sql(clean(row.iloc[11])),
            sql(numeric_rate(rate_text)),
            sql(clean(row.iloc[12])),
            sql(clean(row.iloc[11])),
            sql(clean(row.iloc[2])),
            sql(clean(row.iloc[10])),
            sql(yes_no(clean(row.iloc[13]))),
            sql(clean(row.iloc[14])),
            sql(clean(row.iloc[15])),
            sql(clean(row.iloc[16])),
            sql(clean(row.iloc[17])),
            sql(clean(row.iloc[7])),
            sql(clean(row.iloc[8])),
            "null",
            "null",
            "null",
            sql(received),
            sql(iso_date(clean(row.iloc[5]))),
            sql(rate_text),
            sql(json.dumps(raw, ensure_ascii=False)),
        ]
        rows.append("(" + ", ".join(values) + ")")

    query = """insert into public.applicants (
organization_id, full_name, email, phone, location, timezone, status, status_reason, submitted_at, availability_note,
expected_hourly_rate, education_level, work_status, greatest_dream, referral_source, dedicated_workspace, equipment_summary,
internet_summary, english_proficiency, assessment_summary, loom_video_url, resume_url, talent_review_owner_id, sales_owner_id,
talent_support_owner_id, application_received_at, birth_date, expected_hourly_rate_text, legacy_application_data
) values
""" + ",\n".join(rows) + """
on conflict (organization_id, email) do update set
full_name=excluded.full_name, phone=excluded.phone, submitted_at=excluded.submitted_at, availability_note=excluded.availability_note,
expected_hourly_rate=excluded.expected_hourly_rate, education_level=excluded.education_level, work_status=excluded.work_status,
greatest_dream=excluded.greatest_dream, referral_source=excluded.referral_source, dedicated_workspace=excluded.dedicated_workspace,
equipment_summary=excluded.equipment_summary, internet_summary=excluded.internet_summary, english_proficiency=excluded.english_proficiency,
assessment_summary=excluded.assessment_summary, loom_video_url=excluded.loom_video_url, resume_url=excluded.resume_url,
application_received_at=excluded.application_received_at, birth_date=excluded.birth_date,
expected_hourly_rate_text=excluded.expected_hourly_rate_text, legacy_application_data=excluded.legacy_application_data;
"""
    print(query)


if __name__ == "__main__":
    main()
