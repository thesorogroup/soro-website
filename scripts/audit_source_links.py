import json
import re
import urllib.error
import urllib.request

import pandas as pd


SOURCE = r"C:\\Users\\Matt\\Desktop\\Job Application (Responses) 081626.xlsx"
COLUMNS = [7, 8, 14, 15, 16, 17]


def main():
    applications = pd.read_excel(SOURCE)
    results = []
    for column in COLUMNS:
        total = available = 0
        for raw_value in applications.iloc[:, column].dropna().astype(str):
            for url in re.findall(r"https?://[^,\s]+", raw_value):
                total += 1
                try:
                    request = urllib.request.Request(url, headers={"User-Agent": "Soro Operations Import", "Range": "bytes=0-0"})
                    with urllib.request.urlopen(request, timeout=15) as response:
                        if response.status < 400:
                            available += 1
                except urllib.error.HTTPError as error:
                    if error.code in (301, 302, 303, 307, 308):
                        available += 1
                except (urllib.error.URLError, TimeoutError, ValueError):
                    pass
        results.append({"field": str(applications.columns[column]), "total": total, "available": available})
    print(json.dumps(results))


if __name__ == "__main__":
    main()
