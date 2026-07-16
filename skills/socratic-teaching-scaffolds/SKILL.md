---
name: socratic-teaching-scaffolds
description: Guides learners to discover knowledge through strategic Socratic questioning and progressive scaffolding removal. Combines question ladders, misconception detectors, Feynman explanations, and worked-example fading to build durable understanding. Use when teaching complex concepts, correcting misconceptions, onboarding team members, mentoring problem-solving, or designing self-paced learning. Use when user mentions "teach me", "help me understand", "explain like I'm", "learning path", "guided discovery", or "Socratic method". (Kaynak: github.com/lyndonkl/claude, skill "socratic-teaching-scaffolds", 263+ install, npx skills add lyndonkl/claude --skill socratic-teaching-scaffolds -g -y)
---

# Socratic Teaching Scaffolds

**Core components:**
1. **Question Ladders**: Sequences from simple to complex that build understanding incrementally
2. **Misconception Detectors**: Questions that reveal faulty mental models through contradiction
3. **Feynman Explanations**: Build-up from simple analogies to technical precision
4. **Worked Examples with Fading**: Full solutions → partial solutions → independent practice
5. **Cognitive Apprenticeship**: Model thinking process explicitly, then transfer to learner

**Quick example (Teaching Recursion):**

Question Ladder: (1) "Can you break this problem into a smaller version of itself?" (2) "What would happen if we had only one item?" (base case) (3) "If we could solve the small version, how would we use it for the big version?" (recursive case) (4) "What prevents this from running forever?" (termination)

Misconception Detector: "Will this recursion ever stop? Trace it with 3 items."

Feynman Progression: L1 "Like Russian nesting dolls—each contains a smaller version" → L2 "Function calls itself with simpler input until base case" → L3 "Recursive definition: f(n) = g(f(n-1), n) with f(0) = base"

## Workflow

```
Socratic Teaching Progress:
- [ ] Step 1: Diagnose learner's current understanding
- [ ] Step 2: Design question ladder and scaffolding plan
- [ ] Step 3: Guide discovery through questioning
- [ ] Step 4: Fade scaffolding as competence grows
- [ ] Step 5: Validate understanding and transfer
```

**Step 1: Diagnose** — Ask probing questions to identify current knowledge level, misconceptions, and learning goals (see Question Types below).

**Step 2: Design ladder** — Build progression from learner's current state to target understanding. Simple topics → use [Session Template](#session-template). Complex/multi-misconception topics → use [Advanced Methodology](#advanced-methodology).

**Step 3: Guide discovery** — Ask questions in sequence, provide scaffolding (hints, worked examples, analogies) as needed (see Scaffolding Levels below). Adjust based on learner responses.

**Step 4: Fade scaffolding** — Progressively remove hints, provide less complete examples, ask more open-ended questions. Monitor for struggle (optimal challenge) vs frustration (too hard).

**Step 5: Validate & transfer** — Test with novel problems, ask for explanations in learner's words, check for misconception elimination. Self-check with [Quality Rubric](#quality-rubric-condensed). Minimum standard: average ≥ 3.5/5.

## Socratic Question Types

1. **Clarifying** (understand current thinking): "What do you mean by [term]?" / "Can you give an example?" / "How does this relate to [known concept]?"
2. **Probing Assumptions** (surface hidden beliefs): "What are we assuming here?" / "Why would that be true?" / "Is that always the case?"
3. **Probing Reasons/Evidence** (justify claims): "Why do you think that?" / "What evidence supports that?" / "How would we test that?"
4. **Exploring Implications** (consequences): "What would happen if [change]?" / "What follows from that?" / "What are the edge cases?"
5. **Questioning the Question** (meta-cognition): "Why is this question important?" / "What are we really trying to understand?" / "How would we know if we understood?"
6. **Revealing Contradictions** (bust misconceptions): "Earlier you said [X], but now [Y]. How do these fit?" / "If that's true, why does [counterexample] happen?" / "What would this predict for [test case]?"

## Scaffolding Levels

Match support to current need, then fade:

- **Level 5 — Full Modeling** (I do, you watch): complete worked example, thinking aloud, all steps shown with rationale.
- **Level 4 — Guided Practice** (I do, you help): partial worked example, learner completes steps, hints before errors.
- **Level 3 — Coached Practice** (You do, I help): learner attempts independently, intervene with questions when stuck, guide without giving answers.
- **Level 2 — Independent with Feedback** (You do, I watch): learner solves alone, review/discuss afterwards.
- **Level 1 — Transfer** (You teach someone else): learner explains to others, creates examples, identifies misconceptions in others.

**Fading strategy:** Start at the level matching current competence (not Level 5 by default). Move down one level on success, up one level on repeated struggle.

## Common Patterns

1. **Concept Introduction (Concrete → Abstract)**: real-world analogy → formalize with terminology → abstract definition with edge cases. Ex: pointers (envelope address → memory location → pointer arithmetic).
2. **Misconception Correction (Prediction → Surprise → Explanation)**: ask learner to predict → show actual result (contradicts) → guide discovery of correct model. Ex: "0.1 + 0.2 in code — will it be exactly 0.3?"
3. **Problem-Solving Strategy (Model → Practice → Reflect)**: model on simple problem (think aloud) → learner applies to similar problem (coached) → reflect on when strategy applies/fails.
4. **Depth Ladder (ELI5 → Undergraduate → Expert)**: build multiple explanations at different depths, let learner choose start, offer "go deeper".
5. **Discovery Learning (Puzzle → Hints → Insight)**: present puzzling phenomenon → graduated hints if stuck → guide to "aha" moment.

## Guardrails

- **Zone of proximal development**: too easy = boredom, too hard = frustration. Optimal = can't do alone but can with guidance.
- **Don't fish for specific answers**: not a guessing game. If learner's reasoning is sound but reaches a different conclusion, explore their path.
- **Avoid pseudo-teaching**: every question must advance understanding or reveal a misconception. If a question doesn't help, give a direct explanation instead.
- **Misconception resistance**: deep misconceptions resist single corrections — need multiple exposures to contradictions, sometimes require building the correct model from scratch before dismantling the wrong one.
- **Expertise blind spots**: experts forget what was hard as beginners — make implicit knowledge explicit, slow down automated reasoning to show thinking.
- **Individual differences**: some learners prefer exploration, others structure — adjust style, watch for frustration vs productive struggle.

---

## Advanced Methodology

For complex, multi-faceted, or misconception-heavy topics.

### 1. Advanced Diagnostic Techniques

**Mental Model Elicitation:**
- *Concept Mapping Interview*: "Draw/describe how [concepts] relate to each other" — look for missing connections, incorrect causal arrows, confused hierarchies.
- *Predict-Observe-Explain (POE)*: present scenario → get prediction (reveals mental model) → show actual outcome → ask "Why different from prediction?"
- *Analogical Reasoning Probe*: "This is like [analogy]. How is it similar/different?" — mismatched analogies reveal misconceptions.

**Misconception Taxonomy:**
- *Surface* (single-correction fixable): terminology confusion, memorization errors, single faulty assumption.
- *Deep* (require rebuilding mental model): fundamental misunderstanding (e.g. correlation→causation), coherent-but-wrong model (Aristotelian physics), transferred wrong pattern (linear thinking on exponential problems).

| Misconception Type | Question to Reveal | Correct Understanding |
|---|---|---|
| Causal reversal | "Does A cause B or B cause A?" | Identify correct direction |
| False dichotomy | "Is it X or Y?" (when both/neither) | Reveal multiple possibilities |
| Overgeneralization | "Does this always hold?" | Show edge cases/boundaries |
| Undergeneralization | "When else would this apply?" | Extend to broader contexts |
| Confused levels | "Is this about [high level] or [low level]?" | Separate abstraction layers |

**Prior Knowledge Mapping (Backward Chaining):** ask "what must they know before X?" recursively until you reach confirmed knowledge; start teaching at the first gap.

### 2. Multi-Ladder Design

- **Parallel Ladders**: when a topic has multiple independent facets (e.g. OOP → separate ladders for encapsulation, inheritance, polymorphism), then integrate: "How do these ideas work together in [system design problem]?"
- **Spiral Curriculum**: revisit the concept at increasing depth across sessions — Session 1 intuition, Session 2 application, Session 3 formalization, Session 4 transfer.
- **Concept Lattice Navigation**: concepts form a partial order, not a line. Strategies: breadth-first (all aspects at high level, then drill down), depth-first (master one aspect fully), or learner-directed ("go deeper here, or explore a different angle?").

### 3. Adaptive Questioning

**Branching Question Trees:** prepare 2-3 follow-up paths per question — correct → advance; misconception → targeted correction sequence → verify → advance; stuck → scaffold → retry.

**Misconception-Specific Interventions:**
- *Multiple Contradictions*: a single counterexample gets dismissed as "special case" — give 3-5 diverse ones, ask "what do all these have in common?"
- *Extreme Cases*: push the misconception to an absurd conclusion.
- *Role Reversal*: "You're the teacher. A student says [misconception]. How would you correct them?"
- *Historical Misconception*: "Many scientists thought [X] until [discovery]. Why? What changed?" — legitimizes the struggle.

**Responsive Scaffolding Triggers:**

| Signal | Meaning | Response |
|---|---|---|
| Silent >30s, engaged | Productive struggle | Wait, don't interrupt |
| Silent >2min, disengaged | Stuck/frustrated | Provide hint/scaffolding |
| Partially correct | Close, minor gap | "Almost! What about [aspect]?" |
| Confident wrong answer | Misconception | POE: predict → show contradiction |
| Multiple failed attempts | Too large a leap | Break into smaller steps |
| "I don't know where to start" | Missing entry point | Give a concrete anchor example |

### 4. Strategic Scaffolding Fading

**Cognitive Apprenticeship Model:** Modeling (teacher demonstrates, thinks aloud) → Coaching (student attempts, teacher guides/hints) → Scaffolding (teacher provides structure, student fills in) → Articulation (student explains own reasoning) → Reflection (compare approaches) → Exploration (novel problems, no scaffolding).

**Fade dimensions separately** (don't fade all at once): problem complexity (single-step → multi-step clear path → multi-step multiple paths), hints provided (explicit at each step → only when stuck → none), example completeness (fully worked → partial/starter → spec only).

**ZPD Calibration:** below ZPD (boredom, quick correct answers) → skip ahead; within ZPD (engaged struggle, eventual success with hints) → maintain; above ZPD (frustration, wild guesses, giving up) → increase scaffolding, smaller steps. Start conservative, fade aggressively on success, reinstate immediately if struggle turns to frustration.

### 5. Deep Transfer Validation

**Transfer levels:** Near (same domain, similar problem — procedural memory) → Modified (same domain, modified problem — flexible application) → Far (different domain, analogous structure — deep principle extraction) → Creative (novel synthesis — generative understanding).

**Feynman Understanding Test:** explain to a child (ELI5, intuitive core) → to a peer (relatable, some terms) → to an expert (technical precision, edge cases) → while handling misconceptions (meta-cognitive). True understanding = can explain at all levels.

**Bloom's Taxonomy Validation:** Remember ("What is [definition]?") → Understand ("Explain in your own words") → Apply ("Use X to solve Y") → Analyze ("Why does X work for A but fail for B?") → Evaluate ("Which solution is better and why?") → Create ("Design a new [thing] using X"). Teaching target: Levels 3-4 minimum, 5-6 for mastery.

### 6. Domain-Specific Patterns

- **Programming**: code tracing ("What does this do?" → "Trace with input X" → "Why?"), debugging buggy code, refactoring exercises.
- **Math/Science**: proof discovery (find counterexample or prove), dimensional analysis, limiting cases (parameter → 0 or ∞).
- **Conceptual**: thought experiments (trolley problem, Schrödinger's cat → "What would you do? Why?"), Socratic dialogue (probe assumptions until contradiction).

### 7. Persistent Misconception Strategies

- **Misconception returns after correction**: surface compliance, not deep change → fix with spaced retrieval (test days later, different context, multiple exposures).
- **Learner stuck in a wrong-but-coherent model** (e.g. Aristotelian physics): don't just show counterexamples — build the correct model from scratch, then show it explains everything the old model did *plus* the counterexamples.
- **Guessing instead of reasoning**: fix by making process more important than the answer — "Don't tell me the answer, tell me how you'd figure it out," reward process not just correctness.

**Misconception Resistance Hierarchy:** Fragile (single correction fixes it, e.g. wrong terminology) → Moderate (2-3 corrections in different contexts, e.g. confused variable scope) → Robust (requires rebuilding the mental model, e.g. "objects copied by default in Python") → Foundational (requires prerequisite knowledge first, e.g. quantum mechanics while thinking deterministically — teach probability first).

### 8. Self-Directed Learning Design

Structure: pre-assessment → learning objective → worked example → guided practice (partial examples + hints) → independent practice → self-check with explanations. Hints: hidden by default, 3-5 progressive levels (gentle → explicit), last hint = full solution. Feedback: not just correct/incorrect — wrong → "This suggests [misconception]. Actually, [correction]"; correct → "Right because [principle]." Spaced repetition: review at 1, 3, 7, 14 days, then monthly.

### 9. Quality Indicators

**Excellent:** learner discovers insights themselves; questions reveal thinking, not guess-the-teacher's-answer; scaffolding fades as competence grows; misconceptions corrected through contradiction not assertion; can explain at multiple levels (ELI5→Expert); transfers to novel problems unprompted; starts asking good questions themselves.

**Poor (pseudo-Socratic):** questions are a guessing game; teacher gives the answer when learner doesn't guess it; no scaffolding adjustment; misconceptions ignored or corrected by fiat; only one (usually too technical) explanation level; can only solve problems identical to examples; passive consumption.

---

## Session Template

Use for structuring an actual teaching session end-to-end.

**Learning Profile:** Learner (who/role) · Goal (what to achieve) · Timeline · Current experience (novice/beginner/intermediate/advanced) · Topic · Why it matters · Success criteria.

**1. Diagnostic Phase** — ask 3-5 questions (clarifying, probing, assumption-check, application, misconception-check); log identified gaps and misconceptions; pick a starting scaffolding level.

**2. Question Ladder Design** (10 steps, concrete→abstract):
- Steps 1-2 *Concrete Foundation*: anchor in an analogy/real-world example the learner already understands.
- Steps 3-4 *Pattern Recognition*: guide toward noticing the core regularity/structure.
- Steps 5-6 *Formalization*: introduce precise terminology once the pattern is clear.
- Steps 7-8 *Edge Cases & Boundaries*: explore where the concept breaks down or needs qualification.
- Steps 9-10 *Transfer & Application*: apply to a novel context/domain.

**3. Session Structure:**
- *Opening* (~5 min): state the goal and success criteria; check the learner's motivation ("Why does this matter to you?").
- *Main loop* (~30-45 min), per question: ask clearly, give ≥30s thinking time, don't rush to hint. If correct → confirm, advance. If partial → follow-up to clarify. If misconception → run the Misconception Correction Protocol below. If stuck → scaffold at the appropriate level, then check understanding ("Explain that in your own words" / "How does this connect to [earlier concept]?").
- *Closing* (~10 min): summarize key points, assign a transfer task (novel problem), give next-step practice recommendation.

**4. Scaffolding Fading Protocol:** track level per concept/skill; success → move down one level; struggle >2min → move up one level; repeated failure/frustration → direct explanation, restart at a higher level.

**5. Validation & Assessment:**
- *Explanation test*: "Explain this like I'm [5 / a colleague / an expert]."
- *Application test*: "Use this to solve [novel problem]."
- *Teaching test*: "How would you teach this to someone else?"
- *Misconception elimination*: re-test each identified misconception with a new question; confirm it's actually gone, not just surface-compliant.
- *Transfer*: near (similar problem, no hints) and far (different domain, analogous structure, recognized unprompted).

### Misconception Correction Protocol

1. **Acknowledge without judgment** — "Many people think that."
2. **Predict outcome based on the misconception** — get an explicit prediction.
3. **Show contradiction** — demonstrate/explain the actual outcome.
4. **Guide to the correct model** — ask questions that lead there; don't just state the answer.
5. **Reinforce with 2-3 new examples** applying the corrected understanding.
6. **Check persistence** — return to the trigger later in the session (or a later session) to confirm the correction stuck.

### Quality Checklist (per session)

Diagnostic: 3-5 questions asked · gaps identified · ≥1 misconception detected (if present) · starting scaffolding level determined.
Ladder: ≥8 questions, concrete→abstract · each question has a clear purpose · addresses identified gaps/misconceptions · builds logically.
Execution: started at the right level (not always Level 5) · faded as competence grew · asked, didn't lecture · corrected via contradiction not assertion · adapted to responses.
Validation: tested with a novel (transfer) problem · asked for explanation in learner's own words · verified misconceptions eliminated · gave next steps.
Guardrails: stayed in ZPD · not a guessing game · made implicit knowledge explicit · adapted to learner's pace/preference.

---

## Quality Rubric (condensed)

Full session self-check — score 1-5 on each, target average ≥3.5 (weights shown, higher = more important):

1. **Diagnostic Depth & Accuracy** (1.4) — mental-model elicitation, evidence-based misconception ID, prerequisite mapping, ZPD starting point.
2. **Question Ladder Quality** (1.5) — 10+ questions, concrete→pattern→formal→edge→transfer structure, each with explicit purpose.
3. **Scaffolding Appropriateness & Fading** (1.5) — correct starting level, systematic fading, cognitive-apprenticeship progression, tracked per sub-concept.
4. **Misconception Correction Rigor** (1.4) — full 6-step protocol, multiple diverse counterexamples, spaced-retrieval persistence check.
5. **Transfer & Deep Understanding Validation** (1.3) — near/modified/far/creative transfer, Feynman test, Bloom's validation, teaching test.
6. **ZPD Calibration** (1.3) — explicit signal monitoring, adjusts within ~30s, dynamic per-concept.
7. **Question Purpose & Authenticity** (1.2) — never a guessing game, honors learner's own reasoning path, ≥30s thinking time.
8. **Actionability & Learning Continuity** (1.1) — summary of insights, concrete practice plan, spaced-review schedule, explicit mastery criteria.

**Excellence indicators (checklist):** diagnostic reveals misconceptions with evidence not assumptions · ladder has clear concrete→pattern→formal→edge→transfer structure · every question has explicit purpose · scaffolding starts at the diagnosed level (not defaulting to full modeling) · scaffolding fades systematically per concept · misconceptions corrected via contradiction + discovery, not assertion · multiple counterexamples used for deep misconceptions · spaced-retrieval checks for persistence · ZPD maintained (productive struggle, not bored or frustrated) · transfer validated at multiple levels · Feynman test passed at all 4 levels · teaching test passed · all misconceptions verified eliminated with novel test cases · learner's alternative reasoning paths honored · learning continuity provided (summary + practice plan + spaced review + success criteria).

**Common failure modes to avoid:** guessing game (fishing for the "right" answer instead of honoring reasoning) · no scaffolding adjustment (one-size-fits-all) · misconception by assertion ("No, it's actually X" with no discovery) · no transfer validation (stops at recall) · starting too abstract (skips the concrete/analogy foundation) · insufficient diagnostic (teaches without checking baseline) · persistent misconception ignored (no spaced re-check) · no next steps (session ends with no continuity plan).
