# Methodology

How Social Fabric turns RSS feeds into a temperature. Note - this is only an estimate, not a direct poll of people, it is a very rough,  continuously updated read of the tone of public reporting. I thought maybe a visualization could show the overall state of this very connected world we live in. Please don't make any decisions based on this, just enjoy the tapestry.

## Pipeline

1. **Fetch.** Every 3 hours, `scripts/fetch_and_score.py` reads 110 RSS feeds spanning world news, culture, and markets in English, Spanish, and Chinese, plus the search-based passes described below. Feeds that fail to load are skipped and logged. I hope to add more to this; feel free to suggest sources.
2. **Score.** Each headline and summary gets a sentiment score from -1 to 1. English uses [VADER](https://github.com/cjhutto/vaderSentiment). Spanish and Chinese use curated word-valence lexicons in `scripts/lexicons/`. This could be better and extended using a small LLM as a classifier, I aim to do this.
3. **Aggregate.** Entries are grouped into category/region/language cells, averaged into a 0-100 temperature (50 is neutral), and the highest-valence headlines per cell become the "drivers" shown on hover. The global score is the volume-weighted average across all cells.
4. **Trend.** Daily scores are appended to `data/history/`, giving each cell a rolling trend of about two weeks.

## US drill-down: states and counties

There's no uniform RSS source at state or county scale. Both levels fall back to the same proxy: a Google News search for the place's own name (`"<name>" when:2d`, English only). It's broad but blunt. Not great, not terrible. Counties are a curated shortlist, roughly the top 3 by population per state, about 150 total (`scripts/counties.json`). I'd like to add some geospatial stuff here. 

States are plotted by real latitude and longitude, with Alaska and Hawaii inset like a normal map. Counties are plotted the same way within their state and connected to their nearest neighbors for the woven look. Treat both maps as more approximate than the global weave. A name match in a headline isn't a verified local story, and larger places will show more volume just because they get covered more often. I likely am overselecting for English language sources here anyway, and there is media bias, but it is a start. 

## Known limitations

- Coverage skews toward English-language and US/Western outlets, even on the non-English feeds. As mentioned above.
- The Spanish and Chinese lexicons are hand-curated word lists, not a trained model. They'll miss sarcasm and negation that VADER's rules catch for English. Also I really should use a better newer method.
- The state and county search proxy is coarse by construction (see above).
- Data refreshes every 3 hours. This is a snapshot, not a live stream.

## Legal

Social Fabric is licensed under the MIT License, Copyright 2026 [Twin Kites LLC](https://twinkites.com/). See [LICENSE](LICENSE).

It is not a news source, an opinion poll, or a survey of public sentiment, and it is not investment, legal, medical, or financial advice. Don't rely on it for decisions that matter. Scores are generated automatically by the approximate methods above and are not reviewed by a human before publishing. Headlines, source names, and links point to third-party publishers and remain their property. Social Fabric links to that content for attribution only and claims no ownership of it. We do pass through links that may contain trackers, we don't track you. 
