import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCorpus } from "./corpus.js";
import { parseDataset } from "./dataset.js";
import type {
  BenchmarkDataset,
  BenchmarkMemoryRecord,
  BenchmarkOperation,
  BenchmarkScenario,
  MemoryAbility,
  ScenarioDifficulty,
} from "./types.js";

interface CaseSeed {
  person: string;
  project: string;
  tenant: string;
  otherTenant: string;
  deckCode: string;
  cabinet: string;
  route: string;
  locker: string;
  meal: string;
  oldRoom: string;
  newRoom: string;
  betaDate: string;
  rotationDate: string;
  nonce: string;
  recoveryPhrase: string;
  primaryCode: string;
  secondaryCode: string;
}

interface LanguagePack {
  language: "en" | "tr";
  single: {
    relevant: (seed: CaseSeed) => string;
    distractors: [(seed: CaseSeed) => string, (seed: CaseSeed) => string];
    queries: Array<(seed: CaseSeed) => string>;
  };
  multi: {
    relevant: [(seed: CaseSeed) => string, (seed: CaseSeed) => string];
    distractor: (seed: CaseSeed) => string;
    queries: Array<(seed: CaseSeed) => string>;
  };
  update: {
    before: (seed: CaseSeed) => string;
    after: (seed: CaseSeed) => string;
    queries: Array<(seed: CaseSeed) => string>;
  };
  temporal: {
    distractor: (seed: CaseSeed) => string;
    relevant: (seed: CaseSeed) => string;
    queries: Array<(seed: CaseSeed) => string>;
  };
  abstention: {
    record: (seed: CaseSeed) => string;
    queries: Array<(seed: CaseSeed) => string>;
  };
  isolation: {
    relevant: (seed: CaseSeed) => string;
    forbidden: (seed: CaseSeed) => string;
    queries: Array<(seed: CaseSeed) => string>;
  };
}

const generatorVersion = "core-draft-generator-v1";
const defaultOutput = fileURLToPath(
  new URL("../datasets/core-draft-v0.1.json", import.meta.url)
);

const seeds: CaseSeed[] = [
  {
    person: "Ayla",
    project: "Aurora",
    tenant: "Aster",
    otherTenant: "Beryl",
    deckCode: "OD-417",
    cabinet: "C-28",
    route: "Raven-12",
    locker: "41",
    meal: "lentil salad",
    oldRoom: "Atlas",
    newRoom: "Orion",
    betaDate: "2026-01-04",
    rotationDate: "2026-01-19",
    nonce: "nebula",
    recoveryPhrase: "silver meadow",
    primaryCode: "AX-73",
    secondaryCode: "BR-19",
  },
  {
    person: "Bora",
    project: "Beacon",
    tenant: "Cinder",
    otherTenant: "Dahlia",
    deckCode: "OD-528",
    cabinet: "C-34",
    route: "Harbor-21",
    locker: "52",
    meal: "tomato couscous",
    oldRoom: "Lyra",
    newRoom: "Vega",
    betaDate: "2026-02-05",
    rotationDate: "2026-02-18",
    nonce: "quartz",
    recoveryPhrase: "violet orchard",
    primaryCode: "CX-84",
    secondaryCode: "DL-27",
  },
  {
    person: "Ceren",
    project: "Cobalt",
    tenant: "Elm",
    otherTenant: "Flint",
    deckCode: "OD-639",
    cabinet: "C-45",
    route: "Falcon-33",
    locker: "63",
    meal: "herb noodles",
    oldRoom: "Draco",
    newRoom: "Cygnus",
    betaDate: "2026-03-06",
    rotationDate: "2026-03-17",
    nonce: "marigold",
    recoveryPhrase: "quiet lantern",
    primaryCode: "EM-95",
    secondaryCode: "FT-38",
  },
  {
    person: "Deniz",
    project: "Delta",
    tenant: "Grove",
    otherTenant: "Hazel",
    deckCode: "OD-741",
    cabinet: "C-56",
    route: "Otter-44",
    locker: "74",
    meal: "roasted barley",
    oldRoom: "Perseus",
    newRoom: "Phoenix",
    betaDate: "2026-04-07",
    rotationDate: "2026-04-20",
    nonce: "topaz",
    recoveryPhrase: "amber compass",
    primaryCode: "GV-16",
    secondaryCode: "HZ-49",
  },
  {
    person: "Ekin",
    project: "Ember",
    tenant: "Indigo",
    otherTenant: "Juniper",
    deckCode: "OD-852",
    cabinet: "C-67",
    route: "Kestrel-55",
    locker: "85",
    meal: "sesame rice",
    oldRoom: "Hydra",
    newRoom: "Carina",
    betaDate: "2026-05-08",
    rotationDate: "2026-05-21",
    nonce: "saffron",
    recoveryPhrase: "hidden brook",
    primaryCode: "IG-27",
    secondaryCode: "JP-51",
  },
  {
    person: "Fırat",
    project: "Fjord",
    tenant: "Kite",
    otherTenant: "Linden",
    deckCode: "OD-963",
    cabinet: "C-78",
    route: "Badger-66",
    locker: "96",
    meal: "pepper bulgur",
    oldRoom: "Norma",
    newRoom: "Pavo",
    betaDate: "2026-06-09",
    rotationDate: "2026-06-22",
    nonce: "cobalt",
    recoveryPhrase: "paper moon",
    primaryCode: "KT-38",
    secondaryCode: "LN-62",
  },
  {
    person: "Güneş",
    project: "Garnet",
    tenant: "Moss",
    otherTenant: "Nacre",
    deckCode: "OD-174",
    cabinet: "C-89",
    route: "Heron-77",
    locker: "17",
    meal: "lemon quinoa",
    oldRoom: "Ara",
    newRoom: "Columba",
    betaDate: "2026-07-10",
    rotationDate: "2026-07-23",
    nonce: "willow",
    recoveryPhrase: "crimson harbor",
    primaryCode: "MS-49",
    secondaryCode: "NC-73",
  },
  {
    person: "Hale",
    project: "Helix",
    tenant: "Opal",
    otherTenant: "Pine",
    deckCode: "OD-285",
    cabinet: "C-91",
    route: "Lynx-88",
    locker: "28",
    meal: "mint chickpeas",
    oldRoom: "Dorado",
    newRoom: "Indus",
    betaDate: "2026-08-11",
    rotationDate: "2026-08-24",
    nonce: "cerulean",
    recoveryPhrase: "winter garden",
    primaryCode: "OP-51",
    secondaryCode: "PN-84",
  },
  {
    person: "Ilgaz",
    project: "Ion",
    tenant: "Quartz",
    otherTenant: "Reed",
    deckCode: "OD-396",
    cabinet: "C-13",
    route: "Marten-99",
    locker: "39",
    meal: "sumac beans",
    oldRoom: "Lupus",
    newRoom: "Mensa",
    betaDate: "2026-09-12",
    rotationDate: "2026-09-25",
    nonce: "cypress",
    recoveryPhrase: "golden estuary",
    primaryCode: "QZ-62",
    secondaryCode: "RD-95",
  },
  {
    person: "Jale",
    project: "Jade",
    tenant: "Spruce",
    otherTenant: "Thistle",
    deckCode: "OD-407",
    cabinet: "C-24",
    route: "Tern-10",
    locker: "40",
    meal: "basil polenta",
    oldRoom: "Volans",
    newRoom: "Vulpecula",
    betaDate: "2026-10-13",
    rotationDate: "2026-10-26",
    nonce: "indigo",
    recoveryPhrase: "distant cedar",
    primaryCode: "SP-73",
    secondaryCode: "TH-16",
  },
];

const packs: LanguagePack[] = [
  {
    language: "en",
    single: {
      relevant: (seed) =>
        `For ${seed.person}'s ${seed.project} field briefing, the observation deck code is ${seed.deckCode}.`,
      distractors: [
        (seed) =>
          `For ${seed.person}'s ${seed.project} field briefing, the equipment cabinet is ${seed.cabinet}.`,
        (seed) =>
          `For ${seed.person}'s ${seed.project} lunch briefing, the meal selection is ${seed.meal}.`,
      ],
      queries: [
        (seed) =>
          `Which observation deck code is assigned to ${seed.person}'s ${seed.project} field briefing?`,
        (seed) =>
          `What is the observation deck code for ${seed.person} during the ${seed.project} field briefing?`,
        (seed) =>
          `Recall ${seed.person}'s observation deck code for the ${seed.project} field briefing.`,
        (seed) =>
          `For the ${seed.project} field briefing, identify ${seed.person}'s observation deck code.`,
        (seed) =>
          `${seed.person} needs the ${seed.project} field briefing observation deck code. What is it?`,
      ],
    },
    multi: {
      relevant: [
        (seed) =>
          `For ${seed.project}'s launch review, the courier route is ${seed.route}.`,
        (seed) =>
          `For ${seed.project}'s launch review, the prototype is stored in locker ${seed.locker}.`,
      ],
      distractor: (seed) =>
        `For ${seed.project}'s launch review, the catering order is ${seed.meal}.`,
      queries: [
        (seed) =>
          `Which courier route and prototype locker are assigned to the ${seed.project} launch review?`,
        (seed) =>
          `For ${seed.project}'s launch review, give both the courier route and the prototype locker.`,
        (seed) =>
          `Recall the ${seed.project} launch review route together with its prototype locker.`,
        (seed) =>
          `What route should the ${seed.project} courier use, and where is the launch prototype stored?`,
        (seed) =>
          `The ${seed.project} launch review needs two details: courier route and prototype locker. What are they?`,
      ],
    },
    update: {
      before: (seed) =>
        `The weekly ${seed.project} incident review meets in Room ${seed.oldRoom}.`,
      after: (seed) =>
        `The weekly ${seed.project} incident review now meets in Room ${seed.newRoom}.`,
      queries: [
        (seed) => `Where does the weekly ${seed.project} incident review meet now?`,
        (seed) => `What is the current room for the ${seed.project} weekly incident review?`,
        (seed) => `Recall the latest meeting room for ${seed.project}'s weekly incident review.`,
        (seed) => `Which room currently hosts the weekly ${seed.project} incident review?`,
        (seed) => `The ${seed.project} incident review moved. Where is its weekly meeting now?`,
      ],
    },
    temporal: {
      distractor: (seed) =>
        `${seed.project} signed its beta release on ${seed.betaDate}.`,
      relevant: (seed) =>
        `${seed.project} rotated the API signing key on ${seed.rotationDate}.`,
      queries: [
        (seed) => `On what date did ${seed.project} rotate the API signing key?`,
        (seed) => `When was the ${seed.project} API signing key rotated?`,
        (seed) => `Recall the date of ${seed.project}'s API signing-key rotation.`,
        (seed) => `Which date is tied to the ${seed.project} API key rotation?`,
        (seed) => `Give the rotation date for ${seed.project}'s API signing key.`,
      ],
    },
    abstention: {
      record: (seed) =>
        `The one-time ${seed.nonce} recovery phrase is ${seed.recoveryPhrase}.`,
      queries: [
        (seed) => `What is the one-time ${seed.nonce} recovery phrase?`,
        (seed) => `Recall the ${seed.nonce} one-time recovery phrase.`,
        (seed) => `Which recovery phrase was associated with the one-time ${seed.nonce} token?`,
        (seed) => `Give the deleted one-time recovery phrase labeled ${seed.nonce}.`,
        (seed) => `What recovery phrase belongs to the ${seed.nonce} one-time credential?`,
      ],
    },
    isolation: {
      relevant: (seed) =>
        `For tenant ${seed.tenant}, the invoice escalation code is ${seed.primaryCode}.`,
      forbidden: (seed) =>
        `For tenant ${seed.otherTenant}, the invoice escalation code is ${seed.secondaryCode}.`,
      queries: [
        (seed) => `What is tenant ${seed.tenant}'s invoice escalation code?`,
        (seed) => `Recall the invoice escalation code assigned to ${seed.tenant}.`,
        (seed) => `Which code should ${seed.tenant} use for invoice escalation?`,
        (seed) => `For ${seed.tenant}, identify the tenant invoice escalation code.`,
        (seed) => `${seed.tenant} needs its invoice escalation code. What is it?`,
      ],
    },
  },
  {
    language: "tr",
    single: {
      relevant: (seed) =>
        `${seed.person} için ${seed.project} saha brifingindeki gözlem güvertesi kodu ${seed.deckCode}.`,
      distractors: [
        (seed) =>
          `${seed.person} için ${seed.project} saha brifingindeki ekipman dolabı ${seed.cabinet}.`,
        (seed) =>
          `${seed.person} için ${seed.project} öğle brifingindeki yemek seçimi ${seed.meal}.`,
      ],
      queries: [
        (seed) =>
          `${seed.person} için ${seed.project} saha brifingine atanmış gözlem güvertesi kodu nedir?`,
        (seed) =>
          `${seed.person}, ${seed.project} saha brifinginde hangi gözlem güvertesi kodunu kullanacak?`,
        (seed) =>
          `${seed.person}'in ${seed.project} saha brifingi gözlem güvertesi kodunu hatırla.`,
        (seed) =>
          `${seed.project} saha brifingi için ${seed.person}'in gözlem güvertesi kodunu belirt.`,
        (seed) =>
          `${seed.person}'e ${seed.project} saha brifingi gözlem güvertesi kodu gerekiyor. Kod nedir?`,
      ],
    },
    multi: {
      relevant: [
        (seed) =>
          `${seed.project} lansman incelemesi için kurye rotası ${seed.route}.`,
        (seed) =>
          `${seed.project} lansman incelemesi için prototip ${seed.locker} numaralı dolapta saklanıyor.`,
      ],
      distractor: (seed) =>
        `${seed.project} lansman incelemesi için yemek siparişi ${seed.meal}.`,
      queries: [
        (seed) =>
          `${seed.project} lansman incelemesine atanmış kurye rotası ve prototip dolabı hangileri?`,
        (seed) =>
          `${seed.project} lansman incelemesi için hem kurye rotasını hem prototip dolabını söyle.`,
        (seed) =>
          `${seed.project} lansman incelemesinin rotasını ve prototip dolabını birlikte hatırla.`,
        (seed) =>
          `${seed.project} kuryesi hangi rotayı kullanmalı ve lansman prototipi hangi dolapta?`,
        (seed) =>
          `${seed.project} lansman incelemesi için iki bilgi gerekiyor: kurye rotası ve prototip dolabı. Nedir?`,
      ],
    },
    update: {
      before: (seed) =>
        `Haftalık ${seed.project} olay incelemesi ${seed.oldRoom} odasında yapılıyor.`,
      after: (seed) =>
        `Haftalık ${seed.project} olay incelemesi artık ${seed.newRoom} odasında yapılıyor.`,
      queries: [
        (seed) => `Haftalık ${seed.project} olay incelemesi artık nerede yapılıyor?`,
        (seed) => `${seed.project} haftalık olay incelemesinin güncel odası nedir?`,
        (seed) => `${seed.project} haftalık olay incelemesinin en son toplantı odasını hatırla.`,
        (seed) => `Haftalık ${seed.project} olay incelemesine şu anda hangi oda ev sahipliği yapıyor?`,
        (seed) => `${seed.project} olay incelemesi taşındı. Haftalık toplantı artık nerede?`,
      ],
    },
    temporal: {
      distractor: (seed) =>
        `${seed.project} beta sürümünü ${seed.betaDate} tarihinde imzaladı.`,
      relevant: (seed) =>
        `${seed.project} API imzalama anahtarını ${seed.rotationDate} tarihinde döndürdü.`,
      queries: [
        (seed) => `${seed.project} API imzalama anahtarını hangi tarihte döndürdü?`,
        (seed) => `${seed.project} API imzalama anahtarı ne zaman döndürüldü?`,
        (seed) => `${seed.project} API imzalama anahtarı döndürme tarihini hatırla.`,
        (seed) => `${seed.project} API anahtarı döndürme işlemi hangi tarihle ilişkili?`,
        (seed) => `${seed.project} API imzalama anahtarının döndürülme tarihini ver.`,
      ],
    },
    abstention: {
      record: (seed) =>
        `Tek kullanımlık ${seed.nonce} kurtarma ifadesi ${seed.recoveryPhrase}.`,
      queries: [
        (seed) => `Tek kullanımlık ${seed.nonce} kurtarma ifadesi nedir?`,
        (seed) => `${seed.nonce} tek kullanımlık kurtarma ifadesini hatırla.`,
        (seed) => `Tek kullanımlık ${seed.nonce} belirteciyle ilişkili kurtarma ifadesi hangisiydi?`,
        (seed) => `Silinmiş, ${seed.nonce} etiketli tek kullanımlık kurtarma ifadesini söyle.`,
        (seed) => `${seed.nonce} tek kullanımlık kimlik bilgisine hangi kurtarma ifadesi aitti?`,
      ],
    },
    isolation: {
      relevant: (seed) =>
        `${seed.tenant} kiracısı için fatura yükseltme kodu ${seed.primaryCode}.`,
      forbidden: (seed) =>
        `${seed.otherTenant} kiracısı için fatura yükseltme kodu ${seed.secondaryCode}.`,
      queries: [
        (seed) => `${seed.tenant} kiracısının fatura yükseltme kodu nedir?`,
        (seed) => `${seed.tenant} için atanmış fatura yükseltme kodunu hatırla.`,
        (seed) => `${seed.tenant} fatura yükseltme için hangi kodu kullanmalı?`,
        (seed) => `${seed.tenant} için kiracı fatura yükseltme kodunu belirt.`,
        (seed) => `${seed.tenant} için fatura yükseltme kodu gerekiyor. Kod nedir?`,
      ],
    },
  },
];

function record(
  id: string,
  scope: string,
  content: string,
  observedAt: string,
  ability: MemoryAbility,
  language: string,
  templateId: string
): BenchmarkMemoryRecord {
  return {
    id,
    scope,
    content,
    observedAt,
    metadata: {
      ability,
      language,
      generator: generatorVersion,
      template_id: templateId,
    },
  };
}

function scenario(
  id: string,
  language: string,
  difficulty: ScenarioDifficulty,
  templateId: string,
  description: string,
  operations: BenchmarkOperation[]
): BenchmarkScenario {
  return {
    id,
    description,
    language,
    difficulty,
    provenance: {
      origin: "synthetic",
      author: "openai-codex",
      authorType: "ai",
      templateId,
    },
    review: {
      status: "draft",
      entries: [],
    },
    operations,
  };
}

function buildScenarios(): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];
  for (const pack of packs) {
    for (const [index, seed] of seeds.entries()) {
      const number = String(index + 1).padStart(2, "0");
      const prefix = `draft-${pack.language}-${number}`;
      const primaryScope = `cohort:${pack.language}:${number}`;
      const shadowScope = `shadow:${pack.language}`;
      const variant = index % 5;

      const singleTemplate = `${generatorVersion}/${pack.language}/single/v${variant + 1}`;
      const singleRelevant = `${prefix}-single-relevant`;
      scenarios.push(
        scenario(
          `${prefix}-single`,
          pack.language,
          "basic",
          singleTemplate,
          "Recall one fact among same-scope distractors.",
          [
            {
              op: "write",
              record: record(
                singleRelevant,
                primaryScope,
                pack.single.relevant(seed),
                `${seed.betaDate}T08:00:00Z`,
                "single-memory-recall",
                pack.language,
                singleTemplate
              ),
            },
            ...pack.single.distractors.map(
              (content, distractorIndex): BenchmarkOperation => ({
                op: "write",
                record: record(
                  `${prefix}-single-distractor-${distractorIndex + 1}`,
                  primaryScope,
                  content(seed),
                  `${seed.betaDate}T08:0${distractorIndex + 1}:00Z`,
                  "single-memory-recall",
                  pack.language,
                  singleTemplate
                ),
              })
            ),
            {
              op: "query",
              id: `${prefix}-single-query`,
              scope: primaryScope,
              query: pack.single.queries[variant](seed),
              ability: "single-memory-recall",
              topK: 3,
              relevantIds: [singleRelevant],
              mustContain: [seed.deckCode],
            },
          ]
        )
      );

      const multiTemplate = `${generatorVersion}/${pack.language}/multi/v${variant + 1}`;
      const multiRoute = `${prefix}-multi-route`;
      const multiLocker = `${prefix}-multi-locker`;
      scenarios.push(
        scenario(
          `${prefix}-multi`,
          pack.language,
          "intermediate",
          multiTemplate,
          "Combine two complementary facts while ignoring a topical distractor.",
          [
            {
              op: "write",
              record: record(
                multiRoute,
                primaryScope,
                pack.multi.relevant[0](seed),
                `${seed.betaDate}T09:00:00Z`,
                "multi-memory-recall",
                pack.language,
                multiTemplate
              ),
            },
            {
              op: "write",
              record: record(
                multiLocker,
                primaryScope,
                pack.multi.relevant[1](seed),
                `${seed.betaDate}T09:01:00Z`,
                "multi-memory-recall",
                pack.language,
                multiTemplate
              ),
            },
            {
              op: "write",
              record: record(
                `${prefix}-multi-distractor`,
                primaryScope,
                pack.multi.distractor(seed),
                `${seed.betaDate}T09:02:00Z`,
                "multi-memory-recall",
                pack.language,
                multiTemplate
              ),
            },
            {
              op: "query",
              id: `${prefix}-multi-query`,
              scope: primaryScope,
              query: pack.multi.queries[variant](seed),
              ability: "multi-memory-recall",
              topK: 3,
              relevantIds: [multiRoute, multiLocker],
              mustContain: [seed.route, seed.locker],
            },
          ]
        )
      );

      const updateTemplate = `${generatorVersion}/${pack.language}/update/v${variant + 1}`;
      const updateBefore = `${prefix}-update-v1`;
      const updateAfter = `${prefix}-update-v2`;
      scenarios.push(
        scenario(
          `${prefix}-update`,
          pack.language,
          "intermediate",
          updateTemplate,
          "Return the replacement fact without leaking the superseded value.",
          [
            {
              op: "write",
              record: record(
                updateBefore,
                primaryScope,
                pack.update.before(seed),
                `${seed.betaDate}T10:00:00Z`,
                "knowledge-update",
                pack.language,
                updateTemplate
              ),
            },
            {
              op: "update",
              targetId: updateBefore,
              record: record(
                updateAfter,
                primaryScope,
                pack.update.after(seed),
                `${seed.rotationDate}T10:00:00Z`,
                "knowledge-update",
                pack.language,
                updateTemplate
              ),
            },
            {
              op: "query",
              id: `${prefix}-update-query`,
              scope: primaryScope,
              query: pack.update.queries[variant](seed),
              ability: "knowledge-update",
              topK: 2,
              relevantIds: [updateAfter],
              mustContain: [seed.newRoom],
              mustNotContain: [seed.oldRoom],
            },
          ]
        )
      );

      const temporalTemplate = `${generatorVersion}/${pack.language}/temporal/v${variant + 1}`;
      const temporalRelevant = `${prefix}-temporal-rotation`;
      scenarios.push(
        scenario(
          `${prefix}-temporal`,
          pack.language,
          "intermediate",
          temporalTemplate,
          "Retrieve the date tied to a requested event rather than a nearby event.",
          [
            {
              op: "write",
              record: record(
                `${prefix}-temporal-beta`,
                primaryScope,
                pack.temporal.distractor(seed),
                `${seed.betaDate}T11:00:00Z`,
                "temporal-recall",
                pack.language,
                temporalTemplate
              ),
            },
            {
              op: "write",
              record: record(
                temporalRelevant,
                primaryScope,
                pack.temporal.relevant(seed),
                `${seed.rotationDate}T11:00:00Z`,
                "temporal-recall",
                pack.language,
                temporalTemplate
              ),
            },
            {
              op: "query",
              id: `${prefix}-temporal-query`,
              scope: primaryScope,
              query: pack.temporal.queries[variant](seed),
              ability: "temporal-recall",
              topK: 2,
              relevantIds: [temporalRelevant],
              mustContain: [seed.rotationDate],
            },
          ]
        )
      );

      const abstentionTemplate = `${generatorVersion}/${pack.language}/abstention/v${variant + 1}`;
      const deletedRecord = `${prefix}-abstention-deleted`;
      scenarios.push(
        scenario(
          `${prefix}-abstention`,
          pack.language,
          "basic",
          abstentionTemplate,
          "Return no result after the only matching record is deleted.",
          [
            {
              op: "write",
              record: record(
                deletedRecord,
                primaryScope,
                pack.abstention.record(seed),
                `${seed.betaDate}T12:00:00Z`,
                "abstention",
                pack.language,
                abstentionTemplate
              ),
            },
            {
              op: "delete",
              targetId: deletedRecord,
              scope: primaryScope,
            },
            {
              op: "query",
              id: `${prefix}-abstention-query`,
              scope: primaryScope,
              query: pack.abstention.queries[variant](seed),
              ability: "abstention",
              topK: 3,
              relevantIds: [],
              expectEmpty: true,
              mustNotContain: [seed.recoveryPhrase],
            },
          ]
        )
      );

      const isolationTemplate = `${generatorVersion}/${pack.language}/isolation/v${variant + 1}`;
      const isolationRelevant = `${prefix}-isolation-primary`;
      const isolationForbidden = `${prefix}-isolation-shadow`;
      scenarios.push(
        scenario(
          `${prefix}-isolation`,
          pack.language,
          "advanced",
          isolationTemplate,
          "Keep semantically equivalent facts in another namespace out of results.",
          [
            {
              op: "write",
              record: record(
                isolationRelevant,
                primaryScope,
                pack.isolation.relevant(seed),
                `${seed.betaDate}T13:00:00Z`,
                "scope-isolation",
                pack.language,
                isolationTemplate
              ),
            },
            {
              op: "write",
              record: record(
                isolationForbidden,
                shadowScope,
                pack.isolation.forbidden(seed),
                `${seed.betaDate}T13:01:00Z`,
                "scope-isolation",
                pack.language,
                isolationTemplate
              ),
            },
            {
              op: "query",
              id: `${prefix}-isolation-query`,
              scope: primaryScope,
              query: pack.isolation.queries[variant](seed),
              ability: "scope-isolation",
              topK: 2,
              relevantIds: [isolationRelevant],
              forbiddenIds: [isolationForbidden],
              mustContain: [seed.primaryCode],
              mustNotContain: [seed.secondaryCode],
            },
          ]
        )
      );
    }
  }
  return scenarios;
}

function buildDataset(): BenchmarkDataset {
  return parseDataset({
    schemaVersion: 1,
    name: "memory-bench-core-draft",
    version: "0.1.0",
    license: "CC-BY-4.0",
    track: "core",
    publicationStatus: "draft",
    description:
      "AI-authored bilingual candidate corpus for independent review. Not a leaderboard dataset.",
    scenarios: buildScenarios(),
  });
}

function render(dataset: BenchmarkDataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

function validateGeneratedDataset(dataset: BenchmarkDataset): void {
  const analysis = analyzeCorpus(dataset);
  if (analysis.queryCount !== 120) {
    throw new Error(`draft corpus must contain 120 queries, got ${analysis.queryCount}`);
  }
  for (const [ability, count] of Object.entries(analysis.counts.abilities)) {
    if (count !== 20) {
      throw new Error(`draft corpus must contain 20 ${ability} queries, got ${count}`);
    }
  }
  for (const language of ["en", "tr"]) {
    if (analysis.counts.languages[language] !== 60) {
      throw new Error(
        `draft corpus must contain 60 ${language} queries, got ${
          analysis.counts.languages[language] ?? 0
        }`
      );
    }
  }
  if (analysis.blockingIssues.length > 0) {
    throw new Error(`draft corpus has blocking issues: ${analysis.blockingIssues.join("; ")}`);
  }
  if (analysis.maximumTemplateShare > 0.02) {
    throw new Error(
      `draft corpus template concentration is too high: ${analysis.maximumTemplateShare}`
    );
  }
}

function parseArgs(args: string[]): { check: boolean; output: string } {
  let output = defaultOutput;
  let check = false;
  for (const arg of args) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) throw new Error("--output requires a path");
      output = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { check, output };
}

const options = parseArgs(process.argv.slice(2));
const dataset = buildDataset();
validateGeneratedDataset(dataset);
const rendered = render(dataset);
const digest = createHash("sha256").update(rendered).digest("hex");

if (options.check) {
  if (!fs.existsSync(options.output)) {
    throw new Error(`generated draft corpus is missing: ${options.output}`);
  }
  const current = fs.readFileSync(options.output, "utf8");
  if (current !== rendered) {
    throw new Error(
      `generated draft corpus is stale: run npm run bench:memory:corpus-generate`
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "check",
        output: options.output,
        sha256: digest,
        queries: 120,
      },
      null,
      2
    )
  );
} else {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, rendered);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "write",
        output: options.output,
        sha256: digest,
        queries: 120,
      },
      null,
      2
    )
  );
}
