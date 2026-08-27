// Golden Dataset v1 queries.
//
// AUTHORED AGAINST MEASUREMENTS, NOT INTUITION. Every category below asserts something
// specific about retrieval, and each assertion is mechanically checkable — so each one is
// checked, in `golden-queries.test.ts`, rather than trusted:
//
//   keyword_heavy       the key term must have df = 1 across the document's chunks.
//                       An "exact terminology" query whose term appears in ten chunks
//                       tests nothing.
//   semantic_paraphrase BM25-only must NOT rank the gold chunk first. This is the check
//                       that v0 failed: its single paraphrase query was ranked #1 by BM25
//                       because two of its content words appeared verbatim in the answer.
//                       Roughly half the candidates written for v1 failed this and were
//                       discarded.
//   boundary            the gold interval must touch 2+ chunks. Under the old substring
//                       grader these were unscoreable: evidence spanning a cut is inside no
//                       chunk's text, so `chunk.text.includes(span)` was false everywhere
//                       and the query scored 0 for every retriever, forever.
//   distractor          BM25-only must rank some OTHER chunk above the gold one. Without
//                       these, nothing detects a retriever that pattern-matches on surface
//                       terms.
//   contextual          two required intervals, so any-evidence and all-evidence recall
//                       come apart. Finding one is not having enough to answer.
//   unanswerable        must be IN-domain. An out-of-domain question (v0 asked about
//                       aquarium pH against a biology chapter) is rejected by the cosine
//                       floor trivially and proves only that the embedder works.
//
// Evidence is written here as verbatim SPANS for legibility, and converted to
// `{charStart, charEnd}` intervals at load time by `spanToInterval`, which REJECTS a span
// occurring zero times or more than once. Ambiguity is therefore caught when the dataset is
// authored rather than silently mis-graded forever.

/** Version stamped onto every eval run alongside the corpus version. A metric is only
 *  comparable to another metric produced from the SAME queries; bump this whenever a query
 *  or its evidence changes, so two runs can never be silently compared across a dataset
 *  edit. Corpus version and dataset version move independently — the same three documents
 *  can carry a revised query set. */
export const GOLDEN_SET_VERSION = 'golden-queries-v1'

export type QueryCategory =
  | 'direct_fact'
  | 'keyword_heavy'
  | 'semantic_paraphrase'
  | 'contextual'
  | 'boundary'
  | 'distractor'
  | 'unanswerable'

export interface GoldenQuery {
  id: string
  /** Which corpus document this query is asked against. Retrieval is per-document. */
  documentId: string
  query: string
  category: QueryCategory
  /** Verbatim source spans. Empty for `unanswerable`, where retrieving nothing is correct.
   *  More than one span means the query needs ALL of them to be answerable. */
  evidenceSpans: string[]
  /** For keyword_heavy: the term whose document frequency must be 1. Asserted in tests. */
  keyTerm?: string
  /** What this query is for, when that is not obvious from the category. */
  note?: string
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // ─────────────────────────────────────────────────────────────────────────────
  // openstax-social-psychology — experimental social science.
  // Named studies and researchers give df=1 terms; the heavy shared vocabulary
  // ("group", "behavior", "social") is what makes distractors possible.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'sp-d1',
    documentId: 'openstax-social-psychology',
    query: 'What percentage of Asch’s participants conformed to group pressure at least once?',
    category: 'direct_fact',
    evidenceSpans: ['Asch (1955) found that 76% of participants conformed to group pressure at least once'],
  },
  {
    id: 'sp-d2',
    documentId: 'openstax-social-psychology',
    query: 'Where did Stanley Milgram work when he designed his obedience experiment?',
    category: 'direct_fact',
    evidenceSpans: ['Stanley Milgram was a social psychology professor at Yale'],
  },
  {
    id: 'sp-d3',
    documentId: 'openstax-social-psychology',
    query: 'What is diffusion of responsibility?',
    category: 'direct_fact',
    evidenceSpans: [
      'Diffusion of responsibility is the tendency for no one in a group to help because the responsibility to help is spread throughout the group',
    ],
  },

  {
    id: 'sp-k1',
    documentId: 'openstax-social-psychology',
    query: 'What is scapegoating?',
    category: 'keyword_heavy',
    keyTerm: 'scapegoating',
    evidenceSpans: [
      'Scapegoating is the act of blaming an out-group when the in-group experiences frustration or is blocked from obtaining a goal',
    ],
  },
  {
    id: 'sp-k2',
    documentId: 'openstax-social-psychology',
    query: 'What is situationism?',
    category: 'keyword_heavy',
    keyTerm: 'situationism',
    evidenceSpans: [
      'Situationism is the view that our behavior and actions are determined by our immediate environment and surroundings',
    ],
  },
  {
    id: 'sp-k3',
    documentId: 'openstax-social-psychology',
    query: 'What was the quizmaster study?',
    category: 'keyword_heavy',
    keyTerm: 'quizmaster',
    evidenceSpans: ['a series of experiments known as the quizmaster study'],
  },

  {
    id: 'sp-p1',
    documentId: 'openstax-social-psychology',
    query: 'Why would an ordinary person keep following an instruction to harm a stranger?',
    category: 'semantic_paraphrase',
    evidenceSpans: ['the participants obediently and repeatedly shocked them'],
    note: 'BM25-only ranks a different chunk first; the answer requires knowing this describes obedience to authority.',
  },
  {
    id: 'sp-p2',
    documentId: 'openstax-social-psychology',
    query: 'Why does a crowd of onlookers often fail to assist someone in danger?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'The bystander effect is a phenomenon in which a witness or bystander does not volunteer to help a victim or person in distress',
    ],
  },
  {
    id: 'sp-p3',
    documentId: 'openstax-social-psychology',
    query: 'Why does acting against your own beliefs create mental discomfort?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'defined cognitive dissonance as psychological discomfort arising from holding two or more inconsistent attitudes, behaviors, or cognitions',
    ],
  },

  {
    id: 'sp-c1',
    documentId: 'openstax-social-psychology',
    query: 'What is racism, and why are its modern forms hard to detect?',
    category: 'contextual',
    evidenceSpans: [
      'Racism is prejudice and discrimination against an individual based solely on one’s membership in a specific racial group',
      'One reason modern forms of racism, and prejudice in general, are hard to detect is related to the dual attitudes model',
    ],
    note: 'CROSS-CHUNK. The required intervals sit two chunks apart, so retrieving the definition satisfies any-evidence recall while leaving the query unanswerable. Every contextual query originally had both intervals inside ONE chunk, which made all-evidence recall a duplicate column of any-evidence recall across the entire dataset.',
  },
  {
    id: 'sp-c2',
    documentId: 'openstax-social-psychology',
    query: 'What group conditions make groupthink more likely to occur?',
    category: 'contextual',
    evidenceSpans: [
      'When the group is highly cohesive, or has a strong sense of connection, maintaining group harmony may become more important to the group than making sound decisions',
      'If the group leader is directive and makes his opinions known, this may discourage group members from disagreeing with the leader',
    ],
  },

  {
    id: 'sp-b1',
    documentId: 'openstax-social-psychology',
    query:
      'Besides the credibility of the messenger, what features of the message itself affect persuasion?',
    category: 'boundary',
    evidenceSpans: [
      'the credibility of the messenger (Kumkale & Albarracín, 2004).\n\nFeatures of the message itself that affect persuasion include subtlety',
    ],
    note: 'Evidence straddles a chunk cut. Unscoreable under substring grading.',
  },
  {
    id: 'sp-b2',
    documentId: 'openstax-social-psychology',
    query: 'How does bullying differ between boys and girls, and which parties does bullying involve?',
    category: 'boundary',
    evidenceSpans: [
      'why do you think boys and girls display different types of bullying behavior?\n\nBullying involves three parties: the bully, the victim, and witnesses or bystanders.',
    ],
  },

  {
    id: 'sp-x1',
    documentId: 'openstax-social-psychology',
    query: 'What is the Asch effect?',
    category: 'distractor',
    evidenceSpans: [
      'The Asch effect is the influence of the group majority on an individual’s judgment',
    ],
    note: 'BM25-only ranks a chunk that merely discusses Asch above the one that defines the effect.',
  },

  // In-domain and absent. A psychology student could plausibly ask each of these of this
  // chapter; none is answerable from it.
  {
    id: 'sp-u1',
    documentId: 'openstax-social-psychology',
    query: 'Which brain regions show increased activity during social exclusion?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'sp-u2',
    documentId: 'openstax-social-psychology',
    query: 'What replication rate did large-scale replications of social psychology findings report?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'sp-u3',
    documentId: 'openstax-social-psychology',
    query: 'Which medication is most effective for treating social anxiety disorder?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'sp-u4',
    documentId: 'openstax-social-psychology',
    query: 'How much money does the average household donate to charity each year?',
    category: 'unanswerable',
    evidenceSpans: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // openstax-big-bang — quantitative cosmology.
  // A deliberately different register: numerals, units, instrument and place names.
  // Note how few terms here reach df=1 ("Hubble" is in 16 of 70 chunks, "dark energy" in
  // 19), which is exactly the vocabulary saturation that makes distractors easy to build.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'bb-d1',
    documentId: 'openstax-big-bang',
    query: 'What term did Einstein add to his equations so the universe could stay still?',
    category: 'direct_fact',
    evidenceSpans: [
      'he changed his equations by introducing an arbitrary new term (we might call it a fudge factor) called the cosmological constant',
    ],
  },
  {
    id: 'bb-d2',
    documentId: 'openstax-big-bang',
    query: 'What is the explosion at the beginning of time called?',
    category: 'direct_fact',
    evidenceSpans: [
      'The explosion of that concentrated universe at the beginning of time is called the Big Bang',
    ],
  },
  {
    id: 'bb-d3',
    documentId: 'openstax-big-bang',
    query: 'What did Penzias and Wilson find roosting inside their antenna?',
    category: 'direct_fact',
    evidenceSpans: ['some pigeons had roosted inside the big horn-shaped antenna'],
  },

  {
    id: 'bb-k1',
    documentId: 'openstax-big-bang',
    query: 'What limit must a white dwarf exceed before it collapses and explodes as a type Ia supernova?',
    category: 'keyword_heavy',
    keyTerm: 'Chandrasekhar',
    evidenceSpans: ['exceed the Chandrasekhar limit'],
  },
  {
    id: 'bb-k2',
    documentId: 'openstax-big-bang',
    query: 'In which New Jersey town was the microwave antenna that found the background radiation built?',
    category: 'keyword_heavy',
    keyTerm: 'Holmdel',
    evidenceSpans: [
      'In the mid-1960s, in Holmdel, New Jersey, Arno Penzias and Robert Wilson of AT&T’s Bell Laboratories had built a delicate microwave antenna',
    ],
  },
  {
    id: 'bb-k3',
    documentId: 'openstax-big-bang',
    query: 'At which observatory did Edwin Hubble work?',
    category: 'keyword_heavy',
    keyTerm: 'Mt. Wilson',
    evidenceSpans: ['Edwin Hubble at work in the Mt. Wilson Observatory'],
  },

  {
    id: 'bb-p1',
    documentId: 'openstax-big-bang',
    query: 'What did the researchers first suspect was producing the mysterious hum in their equipment?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'Penzias and Wilson at first thought that any radiation appearing to come from all directions must originate from inside their telescope',
    ],
  },
  {
    id: 'bb-p2',
    documentId: 'openstax-big-bang',
    query: 'If you played a recording of cosmic history in reverse, where would all matter end up?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'The galaxies, instead of moving apart, would move together in our movie—getting closer and closer all the time',
    ],
  },
  {
    id: 'bb-p3',
    documentId: 'openstax-big-bang',
    query: 'What might the emptiness of space itself be storing that pushes everything apart?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'One possibility is that it is the cosmological constant, which is an energy associated with the vacuum of “empty” space itself',
    ],
  },

  {
    id: 'bb-c1',
    documentId: 'openstax-big-bang',
    query:
      'Why does Hubble’s law alone fail for very distant galaxies, and what densities does the standard model assume?',
    category: 'contextual',
    evidenceSpans: [
      'Once we get to large distances, we are looking so far into the past that we must take into account changes in the rate of the expansion of the universe',
      'we have estimated the mass density of ordinary matter plus dark matter as roughly 0.3 times the critical density, and the mass equivalent of dark energy as roughly 0.7 times the critical density',
    ],
    note: 'CROSS-CHUNK: the reason and the numbers land in adjacent chunks.',
  },
  {
    id: 'bb-c2',
    documentId: 'openstax-big-bang',
    query: 'What is one proposed source of dark energy, and how have attempts to calculate its size gone?',
    category: 'contextual',
    evidenceSpans: [
      'the source of this vacuum energy might be tiny elementary particles that flicker in and out of existence everywhere throughout the universe',
      'Various attempts have been made to calculate how big the effects of this vacuum energy should be, but so far these attempts have been unsuccessful',
    ],
  },

  {
    id: 'bb-b1',
    documentId: 'openstax-big-bang',
    query: 'What is a flat universe, and what determines the overall geometry of space?',
    category: 'boundary',
    evidenceSpans: [
      'We refer to this as a flat universe, and the kind of Euclidean geometry you learned in high school applies in this type of universe.\n\nPicturing Space Curvature for the Entire Universe.\n\nThe density of matter and energy determines the overall geometry of space.',
    ],
  },

  {
    id: 'bb-x1',
    documentId: 'openstax-big-bang',
    query: 'How old is the universe?',
    category: 'distractor',
    evidenceSpans: [
      'the universe is 13.8 billion years old with an uncertainty of only about 100 million years',
    ],
    note: '"13.8 billion" appears in four chunks; BM25 ranks one that mentions the figure above the one that states the measurement.',
  },

  {
    id: 'bb-u1',
    documentId: 'openstax-big-bang',
    query: 'What is the measured mass of the lightest neutrino species?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'bb-u2',
    documentId: 'openstax-big-bang',
    query: 'How many galaxies has the James Webb Space Telescope catalogued beyond redshift 10?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'bb-u3',
    documentId: 'openstax-big-bang',
    query: 'What is the surface temperature of a typical white dwarf star?',
    category: 'unanswerable',
    evidenceSpans: [],
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // openstax-patent-enforcement — legal prose.
  // The third register, and the one with the sharpest split: doctrine names and statute
  // citations are df=1, while "infringement", "patent" and "Federal Circuit" saturate the
  // document. That split is what makes this the best source of distractor queries.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'pt-d1',
    documentId: 'openstax-patent-enforcement',
    query: 'Does the USPTO enforce the patents it issues?',
    category: 'direct_fact',
    evidenceSpans: [
      'The USPTO is responsible only for examining and issuing patents—it does not enforce them',
    ],
  },
  {
    id: 'pt-d2',
    documentId: 'openstax-patent-enforcement',
    query: 'What kinds of monetary damages can a successful patentee recover?',
    category: 'direct_fact',
    evidenceSpans: [
      'successful patentees can reap huge monetary damages for another’s patent infringement, including lost profits',
    ],
  },

  {
    id: 'pt-k1',
    documentId: 'openstax-patent-enforcement',
    query: 'Which legal rule covers elements that are equivalent but not literally within a claim?',
    category: 'keyword_heavy',
    keyTerm: 'doctrine of equivalents',
    evidenceSpans: ['the legal rule called the “doctrine of equivalents.”'],
  },
  {
    id: 'pt-k2',
    documentId: 'openstax-patent-enforcement',
    query: 'What are treble damages?',
    category: 'keyword_heavy',
    keyTerm: 'treble',
    evidenceSpans: ['treble damages (i.e., triple the amount of money damages found)'],
  },

  {
    id: 'pt-p1',
    documentId: 'openstax-patent-enforcement',
    query:
      'Can a competitor escape liability by swapping one component for something that works the same way?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'If the accused device or process performs substantially the same function in substantially the same way and yields substantially the same result, infringement exists',
    ],
  },
  {
    id: 'pt-p2',
    documentId: 'openstax-patent-enforcement',
    query: 'What happens if a rights holder sits on a complaint for years before finally suing?',
    category: 'semantic_paraphrase',
    evidenceSpans: [
      'the accused infringer is arguing that you waited too long to bring your infringement claim',
    ],
  },

  {
    id: 'pt-c1',
    documentId: 'openstax-patent-enforcement',
    query: 'How long after the complaint do pretrial proceedings begin, and what are the first steps once they do?',
    category: 'contextual',
    evidenceSpans: [
      'Once these initial pleadings are filed, which usually takes about 60 days from when the initial complaint is filed, the case is considered “at issue” and the pretrial proceedings commence',
      'The first steps in the pretrial procedure are the filing by the parties of their “initial disclosures” and the holding of the preliminary pretrial conference',
    ],
    note: 'CROSS-CHUNK: the timing closes one section, the first steps open the next.',
  },
  {
    id: 'pt-c2',
    documentId: 'openstax-patent-enforcement',
    query: 'What gives rise to claim construction disputes, and who decides the meaning of the language?',
    category: 'contextual',
    evidenceSpans: [
      'In virtually every patent case, a dispute arises over the meaning of certain language used in the asserted claims of the patents at issue',
      'after the name of the case that established that the judge, and not the jury, must decide the proper meaning of disputed claim language',
    ],
  },

  {
    id: 'pt-b1',
    documentId: 'openstax-patent-enforcement',
    query:
      'What exception to but-for materiality did the court recognise, and what happened to inequitable conduct defences afterwards?',
    category: 'boundary',
    evidenceSpans: [
      'the misconduct is material.”\n\nThe number of successful inequitable conduct defenses asserted has plummeted',
    ],
  },
  {
    id: 'pt-b2',
    documentId: 'openstax-patent-enforcement',
    query: 'How soon should a patent lawsuit be filed, and what is the outer time limit before a defence arises?',
    category: 'boundary',
    evidenceSpans: [
      'lawsuits should usually be filed as soon after the infringing activity\nis discovered as possible, given the need to investigate and prepare before filing a complaint.\n\nAt the outside, any suit filed more than six years after the infringement began',
    ],
  },

  {
    id: 'pt-x1',
    documentId: 'openstax-patent-enforcement',
    query: 'When can a court award enhanced damages for willful infringement?',
    category: 'distractor',
    evidenceSpans: [
      'This further restricts the opportunity for a patentee to prove that a defendant’s infringement was willful',
    ],
    note: '"willful" appears in 7 chunks; BM25 ranks one of the others first.',
  },
  {
    id: 'pt-x2',
    documentId: 'openstax-patent-enforcement',
    query: 'Who can be sued for patent infringement?',
    category: 'distractor',
    evidenceSpans: [
      'If someone makes, uses, offers for sale, sells, or imports what is covered by a claim of a valid patent, that person is an infringer',
    ],
  },
  {
    id: 'pt-x3',
    documentId: 'openstax-patent-enforcement',
    query: 'How often are claim construction rulings overturned on appeal?',
    category: 'distractor',
    evidenceSpans: [
      'the Federal Circuit reverses claim construction decisions at a rate nearly twice as high as decisions without claim construction issues (32 percent vs. 18 percent)',
    ],
    note: '"Federal Circuit" is in 12 chunks and "claim construction" in several more: maximum lexical saturation, and BM25 ranks a neighbouring chunk above the one carrying the figure.',
  },

  {
    id: 'pt-u1',
    documentId: 'openstax-patent-enforcement',
    query: 'What is the filing fee for a provisional patent application?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'pt-u2',
    documentId: 'openstax-patent-enforcement',
    query: 'How many patent applications did the USPTO grant last year?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
  {
    id: 'pt-u3',
    documentId: 'openstax-patent-enforcement',
    query: 'How many years does a design patent remain in force?',
    category: 'unanswerable',
    evidenceSpans: [],
  },
]
