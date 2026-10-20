# Pakistan CPI inflation dataset

- File: `pakistan_inflation_world_bank.csv`
- Country: Pakistan (World Bank code `PAK`)
- Measure: annual consumer price inflation, percent change
- Indicator: `FP.CPI.TOTL.ZG`
- Coverage: 1960–2025; 66 annual observations
- Source: [World Bank indicator page](https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=PK)
- Data API: <https://api.worldbank.org/v2/country/PAK/indicator/FP.CPI.TOTL.ZG?format=json&per_page=1000>
- Retrieved: 2026-10-20

`Date` is the observation year written as January 1 so InsightFlow can recognize it as a date and draw a yearly trend. `Inflation_Rate_Percent` is the World Bank's annual CPI inflation value. This is an annual rate, not the price index or a monthly measure.
