# Quality test

Back to the [docs index](README.md).

The review benchmark shows whether reviewers are right about warnings. This test asks two different questions: did the plan decide what a plan for this objective has to decide, and does the brief say anything its ledger never proposed?

## How it works

- **Checklists.** Each of four objectives has 10 requirements, in `app/quality_cases.json`. They were written from the objective alone, before any brief was read for this purpose.
- **Controls.** Each checklist has two short documents with known answers, which meet opposite items and only name the rest. Saying yes to everything scores 50%. Each is tested again inside about 15,000 characters of text about an unrelated objective, because real briefs are that long.
- **Judges.** Up to four of the cheapest providers take the controls, and a judge needs to find at least 90% of met items and wrongly pass at most 10%. Three calibrated judges score each document. Below two, nothing is scored.
- **Quotes.** A judge must copy the words that meet an item. A quote not found in the document turns that pass into a miss.
- **Blind.** Judges see the objective, the checklist and the text. They never see the writer or setup, and a model never judges its own brief.
- **Ranges.** An item counts only at the review's 80% agreement. Otherwise it is split, and scores show low (splits missing) to high (splits met).
- **Several parts.** An item with several parts is met only if every part is.
- **One item per call.** Each judge sees one requirement at a time, so its view of the whole document cannot decide every item. A full test made 1,121 calls and cost $2.19 at list prices, slightly over the default $2 cap, which is checked between briefs.

Open **Quality** in the app to test your newest finished run of each objective:

- Plan an offline-first notes app with sync
- Design a rate limiter for a public REST API that must stay fair across tenants during traffic spikes
- Design a backup system for a small business that can survive ransomware
- Plan a shared family recipe app that works offline and lets relatives edit the same recipe

## What it found

Briefs scored 0 to 1 of 10 while their ledgers scored 6 to 9. The cause was the context limit. Warnings were never trimmed, and in a 40,000-character limit they left little or no room for the design. In one run of 16 stages, the brief writer saw **0 of 566** design items, and stage 16 saw 3. What was left went to the newest entries, although most checklist items first appear in stages 1 to 5.

The fix keeps every warning but gives the design at least half the limit, taking earliest and newest entries in turn. When warnings are grouped, the brief receives the groups in their place. Every warning remains in the ledger and in Decisions.

### Same ledgers, new briefs

Four writers on five ledgers, 20 briefs each. Coverage is out of 10.

| Brief input | Coverage | Prompt size |
| --- | ---: | ---: |
| Before | 0.7 to 1.7 | about 40,000 |
| New instruction only | 1.1 to 2.9 | 42,040 |
| Context fix only | 3.2 to 5.3 | 45,377 |
| **Both (shipped)** | **3.9 to 6.0** | **45,377** |
| All warnings plus design floor | 3.8 to 5.7 | 57,561 |
| Whole ledger | 3.8 to 6.0 | 159,797 |

"Before" had 25 briefs. The whole ledger cost 3.5 times the prompt and added nothing, so the shipped option is the small one.

### Full chains, before and after

The same four objectives and models, with one chain each and identical judging.

| Objective | Ledger before | Ledger after | Brief before | Brief after | Items lost before | Items lost after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Notes | 6–8 | 4–9 | 1 | 7 | 5 | 0 |
| Rate limiter | 8–9 | 9 | 0 | 5–7 | 8 | 2 |
| Backup | 4–8 | 4–8 | 0 | 4–7 | 4 | 0 |
| Recipes | 5–8 | 4–6 | 0–1 | 0–6 | 4 | 1 |
| **Average** | **5.8–8.3** | **5.3–8.0** | **0.3–0.5** | **4.0–6.8** | **5.3** | **0.8** |

A lost item is one met in the ledger and judged missing from the brief.

- **Cost:** $0.32 before and $0.36 after, at list prices, an increase of 12%.
- **Length:** briefs fell from 13,253–21,664 to 9,178–10,017 characters while covering far more. Length was a poor signal of quality.
- **Ledgers did not improve.** Giving stages the design cost most of that 12% and showed no measured coverage gain. It stays because the alternative leaves late stages blind to the design, but the benefit is unproven.
- **Warnings rose** from an average of 163 to 184 per run. Four chains each is too few to say why.

## Claims the ledger never made

Coverage cannot see invention, because an invented claim can still meet a checklist item. So each brief's claims are also traced to the ledger.

- **Claims.** Code splits the Approach, Build steps and How to test it sections into sentences, so no model picks what is checked. Risks are left out, because they repeat warnings.
- **Evidence.** Code finds each claim's 12 closest ledger records, weighting rare words most. A judge must cite one of those records to call a claim supported, and any other citation counts as unsupported.
- **Judges.** They are tested on 40 control claims, half invented: changed numbers, swapped products, reversed decisions and plain inventions. Each must catch 90% and wrongly flag at most 10%.
- **Fakes.** Every test hides 8 fake claims among a brief's real ones: 5 fabricated, naming products or figures no plan here uses, and 3 distorted, stating with ordinary words what a plan should not, such as failing closed. A fake is skipped if the ledger really contains it. Fakes go through the same calls and are reported apart.
- **No model at all.** Numbers and code-style names in the brief that never appear in the ledger are listed directly.

### Results

Four judges were tested on the controls, and all four scored 100%.

| Briefs | Claims | Traced | Not traced | Split | Fakes caught | New numbers or names |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before the fix, 4 briefs | 99 | 85 | 4 | 10 | 20 of 20 | 0 |
| After the fix, 4 briefs | 171 | 144 | 5 | 22 | 20 of 20 | 0 |
| Same, rescored from the app | 171 | 136 | 4 | 31 | 32 of 32 | 0 |

The rescoring included the 12 distorted fakes, and all 12 were caught, as they were in a separate test against the same ledgers. No fake was ever judged supported.

I read all five untraced claims in the current briefs against their records. None invents a mechanism. Four combine several records into one sentence, such as a list of tests drawn from separate entries. One turns a ledger example, "e.g., > 7.5 bits per byte", into "the proposed threshold". On this evidence the briefs summarize rather than invent, and nothing needed fixing.

Two faults surfaced along the way and were fixed. MiMo sometimes dropped the last brace of a complete answer, which threw away whole batches. That repair is in the shared parser, so review votes benefit too. A fake with no related records was caught automatically, whatever the judge said, so only fakes that reached a judge with records count as a test.

### Limits of tracing

- **Supported is not true.** It means the ledger proposed the claim. The ledger itself is unverified.
- **Retrieval can miss.** If a claim's support uses different words, its records may not be shown, and it would be flagged. That error makes the brief look worse, never better.
- **Combined claims split.** Judges disagree on sentences that join several records, which is most of the split column.
- **Fakes are one author's.** Catching these 32 fakes does not prove every invention is caught, especially one that is close to something the ledger says.

## Steadier scores

Repeat scorings disagreed by up to 5 items at the low end. Each judge was then asked the same four briefs five times, to find out why.

- **Random noise was small.** A judge changed its answer on 2 to 9 of 40 items across five tries.
- **Judges disagreed in fixed ways.** On 12 of 40 items, judges reliably gave different answers. Reading each one showed two causes. DeepSeek passed an item when one part of it was met, while Mistral wanted every part. MiMo answered "not met" to every recipes item, including plainly met ones, although it passed every short control.

Two changes followed. Judges are told that every part of an item must be met. Controls are also tested at brief length, which lowered MiMo's score from 100% to 97% but did not reproduce its failure. The cause was found later, and is described below.

| Three judges, same briefs | Low-end spread between repeats | Width of the range | Items judges split on |
| --- | ---: | ---: | ---: |
| Before | 0.62 items | 3.2 items | 12 of 40 |
| After | 0.29 items | 2.9 items | 13 of 40 |

Spread is the average standard deviation of the low score over 300 simulated scorings, drawn from real repeated answers. Repeats now land within about a third of an item of each other. The range did not narrow, because judges still read about a third of the items differently. That width is genuine disagreement, and the score shows it as a range, not as a single number.

On the 11 disputed items, the judges agreed with my own reading as follows: Mistral 8 of 11 before the rule and 10 of 11 after, Kimi 6, DeepSeek 5 and MiMo 5. My reading is one more opinion, not ground truth.

### Why MiMo failed recipes

MiMo did not judge the ten items separately. It formed one view of whether a document addressed the checklist and applied it to every item.

- The brief's sentence "each device keeps … derived recipe view for offline use" failed f1 inside the real brief, or alone. Placed among a few clearly met lines, it passed every time.
- Adding three clear lines to the real brief turned f1, f2 and f5 to met, on evidence that was already there.

Four other explanations were tested and ruled out. MiMo scored 9 or 10 of 10 on controls rewritten in the brief's hedged style, in engineering jargon, and with behavior only implied by a mechanism, and three instruction changes left it at 0 to 2 on recipes. Short controls cannot catch this, because each is clear-cut.

The same effect ran the other way for DeepSeek, which passed recipes items f3, f8 and f9 when they came together and not one at a time. So each item now gets its own call. On the three briefs measured before the Ollama Cloud monthly limit stopped the test:

| Three judges, same briefs | All items in one call | One item per call |
| --- | ---: | ---: |
| Items judges disagree on | 12 of 30 | 4 of 30 |
| MiMo agrees with my reading | 4 of 10 | 7 of 10 |
| DeepSeek agrees with my reading | 4 of 10 | 8 of 10 |
| Mistral agrees with my reading | 9 of 10 | 9 of 10 |

A full test from the app, on the same four runs:

| Brief | All items in one call | One item per call |
| --- | ---: | ---: |
| Recipes | 1–7 | 2–4 |
| Backup | 2–7 | 3–7 |
| Notes | 5–7 | 4–6 |
| Rate limiter | 6–7 | 4–7 |
| **Items split, of 40** | **14** | **11** |
| Cost | $0.63, 180 calls | $2.19, 1,121 calls |

- **Recipes** narrowed most, from 6 split items to 2. Rate limiter widened from 1 to 3, so the gain is not uniform.
- **Agreement:** where the panel decided a disputed item, it matched my reading 6 times of 6, against 2 of 2 before.
- **Lost items** now show where they did not: recipes f3 and f9, and notes n10. My reading had all three missing from the brief.
- **Calibration:** MiMo, DeepSeek and Mistral scored 97.5%. Kimi's false passes rose to 21%, so it is no longer calibrated. It was the spare seat, so the panel did not change.
- **Ledgers:** once a judge finds an item in one part of a ledger, later parts no longer ask about it. Verdicts are the same, and this kept the first full run's cost near the $2 default cap instead of about $3.80. One run with the full ledger reached the cap after two briefs.
- One of 1,121 calls returned no readable answer and abstained.

Spend is now reported under judging ($1.89) and tracing ($0.30) instead of under stages.

## Writers

Eight writers on five old ledgers, before the fix, scored too low to rank. After the fix, in 15 briefs per writer across the three context options, Kimi K2.7 scored 4.4–6.4, MiMo Flash 4.1–6.0, Mistral 3.7–5.7 and Terra 3.1–5.3. Those ranges overlap. No change of writer is justified, and a repeat is needed on fixed ledgers.

## Limits

- **One author.** The checklists and controls share an author with this analysis, so they measure coverage of that author's list. A high score does not mean a plan is good, correct or safe.
- **Easy controls.** Judges scored 96% to 100% on short documents, which is a floor. Real briefs are longer and judges split on more items there, as Recipes shows.
- **Small samples.** Each full-chain cell is one chain. Treat the size of the brief gain as real and the differences between objectives as noise.
- **Not measured:** whether a brief's reasoning holds, and whether anyone could build from it.
- **Ranges are wide.** Judges still split on about a third of the items, so a range is often 3 items wide. Compare whole ranges, and treat a difference smaller than that width as no difference. Scores from before the several-parts rule used a different test and do not compare.
- **Ledger scoring is generous.** An item passes for a judge if any part of a long ledger meets it, and judges of a ledger may have written parts of it.

A changed checklist or judge instruction changes the test's hash, and the app then warns that older scores do not compare.
