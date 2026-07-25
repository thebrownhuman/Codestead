import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/u;
const ENTRY_KEYS = Object.freeze([
  "breakpoints",
  "idx",
  "sqlSha256",
  "tag",
  "version",
  "when",
]);
const JOURNAL_ENTRY_KEYS = Object.freeze([
  "breakpoints",
  "idx",
  "tag",
  "version",
  "when",
]);
const JOURNAL_ROOT_KEYS = Object.freeze(["dialect", "entries", "version"]);
const DEFAULT_DRIZZLE_DIRECTORY = fileURLToPath(
  new URL("../../drizzle/", import.meta.url),
);

export class ReviewedMigrationLedgerError extends Error {
  constructor(code, options) {
    super(`reviewed migration ledger verification failed: ${code}`, options);
    this.name = "ReviewedMigrationLedgerError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReviewedMigrationLedgerError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function canonicalEntry(entry) {
  return {
    idx: entry.idx,
    version: entry.version,
    when: entry.when,
    tag: entry.tag,
    breakpoints: entry.breakpoints,
    sqlSha256: entry.sqlSha256,
  };
}

function validateReviewedMigrationLedger(entries, code) {
  if (!Array.isArray(entries) || entries.length === 0) fail(code);
  const tags = new Set();
  const timestamps = new Set();
  let previousWhen = -1;

  for (const [position, entry] of entries.entries()) {
    const expectedPrefix = String(position).padStart(4, "0");
    if (
      !exactKeys(entry, ENTRY_KEYS) ||
      entry.idx !== position ||
      typeof entry.version !== "string" ||
      !/^[0-9]+$/u.test(entry.version) ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousWhen ||
      typeof entry.tag !== "string" ||
      !TAG_PATTERN.test(entry.tag) ||
      !entry.tag.startsWith(`${expectedPrefix}_`) ||
      typeof entry.breakpoints !== "boolean" ||
      typeof entry.sqlSha256 !== "string" ||
      !SQL_SHA256_PATTERN.test(entry.sqlSha256) ||
      tags.has(entry.tag) ||
      timestamps.has(entry.when)
    ) {
      fail(code);
    }
    tags.add(entry.tag);
    timestamps.add(entry.when);
    previousWhen = entry.when;
  }
}

export function reviewedMigrationLedgerSha256(entries) {
  validateReviewedMigrationLedger(entries, "CONTRACT_INVALID");
  const bytes = Buffer.from(
    `${JSON.stringify(entries.map(canonicalEntry))}\n`,
    "utf8",
  );
  return createHash("sha256").update(bytes).digest("hex");
}

export function appendReviewedMigrationLedgerEntry(entries, nextEntry) {
  try {
    validateReviewedMigrationLedger(entries, "CONTRACT_EXTENSION_INVALID");
    if (!exactKeys(nextEntry, ENTRY_KEYS)) {
      fail("CONTRACT_EXTENSION_INVALID");
    }
    const previous = entries.at(-1);
    const canonical = canonicalEntry(nextEntry);
    const expectedPrefix = String(entries.length).padStart(4, "0");
    if (
      canonical.idx !== entries.length ||
      canonical.version !== previous.version ||
      canonical.when <= previous.when ||
      !canonical.tag.startsWith(`${expectedPrefix}_`) ||
      entries.some(
        (entry) =>
          entry.tag === canonical.tag || entry.when === canonical.when,
      )
    ) {
      fail("CONTRACT_EXTENSION_INVALID");
    }
    const extended = [...entries, Object.freeze(canonical)];
    validateReviewedMigrationLedger(extended, "CONTRACT_EXTENSION_INVALID");
    return Object.freeze(extended);
  } catch (error) {
    if (
      error instanceof ReviewedMigrationLedgerError &&
      error.code === "CONTRACT_EXTENSION_INVALID"
    ) {
      throw error;
    }
    fail("CONTRACT_EXTENSION_INVALID", error);
  }
}

export const REVIEWED_MIGRATION_LEDGER = Object.freeze([
  Object.freeze({ idx: 0, version: "7", when: 1783804640793, tag: "0000_workable_deadpool", breakpoints: true, sqlSha256: "9a928d52f4f80a9e33938d90a14638bf4477c40bd0ad491b9caa03aca34ee146" }),
  Object.freeze({ idx: 1, version: "7", when: 1783804714660, tag: "0001_nostalgic_thunderball", breakpoints: true, sqlSha256: "ae992bc2da0ac0598c65cd9efde2ecd2904f6548f6bd1eb7305ca3bc0bbd2a5f" }),
  Object.freeze({ idx: 2, version: "7", when: 1783806065977, tag: "0002_nappy_alex_power", breakpoints: true, sqlSha256: "baea312a7aa67393238e54de4ea79b2a009db3a8fa4bcfcc78b02919e089a7db" }),
  Object.freeze({ idx: 3, version: "7", when: 1783806111718, tag: "0003_colorful_gateway", breakpoints: true, sqlSha256: "81416b9ede2e50263a8e239938e255eb3e04536733722887bb090ea5ca753e99" }),
  Object.freeze({ idx: 4, version: "7", when: 1783806308206, tag: "0004_windy_peter_quill", breakpoints: true, sqlSha256: "682ab52e6f9deb819707250fe20b756136e4d0392866bd78ba7beb68109a644a" }),
  Object.freeze({ idx: 5, version: "7", when: 1783831234853, tag: "0005_nasty_puff_adder", breakpoints: true, sqlSha256: "f2093d48dc8d86570b899094599d1c2b96cc0c73139487eb01d160e5b1bac2a0" }),
  Object.freeze({ idx: 6, version: "7", when: 1783831582375, tag: "0006_loving_carlie_cooper", breakpoints: true, sqlSha256: "c51bb630b22e0737c0cd34a20647176a2d0ede35945f83fc212809dc65192c0d" }),
  Object.freeze({ idx: 7, version: "7", when: 1783831802561, tag: "0007_perpetual_shocker", breakpoints: true, sqlSha256: "3d8f446274edb41bbe0bec45b39744c5b7d1537e5644c8aade085d4184546918" }),
  Object.freeze({ idx: 8, version: "7", when: 1783832732621, tag: "0008_abandoned_sumo", breakpoints: true, sqlSha256: "9e6c08f0ed6d44d63aa9d4ee75acd372ae5bf95e0fb1adc221ab241503b6303d" }),
  Object.freeze({ idx: 9, version: "7", when: 1783835952537, tag: "0009_orange_miss_america", breakpoints: true, sqlSha256: "14fe757faa998f6c53bc07eef329cc106db281a424761271bd846b4063fe40a8" }),
  Object.freeze({ idx: 10, version: "7", when: 1783836112653, tag: "0010_tricky_lord_tyger", breakpoints: true, sqlSha256: "4d40b69d280a867dc82b6d85f031fd05bd31e93ae1e01241ef89ce76d57adeb5" }),
  Object.freeze({ idx: 11, version: "7", when: 1783839805340, tag: "0011_dapper_ghost_rider", breakpoints: true, sqlSha256: "03e50f27756eb76139098151289011d121917bd2aff42cfeb75d965ba7f692a2" }),
  Object.freeze({ idx: 12, version: "7", when: 1783840246863, tag: "0012_appeal_immutability", breakpoints: true, sqlSha256: "8fa94a82633abc3993c3f48a4646ce5a4e70be1551be1c2c717777f4bd4eb286" }),
  Object.freeze({ idx: 13, version: "7", when: 1783840680788, tag: "0013_milky_dark_beast", breakpoints: true, sqlSha256: "779c467fefefd4518666f61890a11efe6bce653dca34f48b67fe2d7ba5ba5e2e" }),
  Object.freeze({ idx: 14, version: "7", when: 1783840687155, tag: "0014_curriculum_immutability", breakpoints: true, sqlSha256: "c1461f3e970b1da0b7203131cb3b6f1819146f5d7e4f92bb69556194f99e5d85" }),
  Object.freeze({ idx: 15, version: "7", when: 1783842358757, tag: "0015_classy_sumo", breakpoints: true, sqlSha256: "4739c1366c8dd1c2520455167774ebf3a14c2a0057350023901455cec086c6b4" }),
  Object.freeze({ idx: 16, version: "7", when: 1783842780267, tag: "0016_lovely_kinsey_walden", breakpoints: true, sqlSha256: "c5ecce582f7297c4fe5ff050f8e5b969e5756e2e3f769cecf41d877a2db62dc3" }),
  Object.freeze({ idx: 17, version: "7", when: 1783844127809, tag: "0017_spooky_glorian", breakpoints: true, sqlSha256: "0a1a5f76ee48d330f7d854c7667e856894f38c7d36cb4dbee5def7ab29cb91e6" }),
  Object.freeze({ idx: 18, version: "7", when: 1783846419881, tag: "0018_wealthy_loners", breakpoints: true, sqlSha256: "5c2418672c08ccca2039ce4ec4d58c64022c7288554a1d04adad576253297acd" }),
  Object.freeze({ idx: 19, version: "7", when: 1783847505831, tag: "0019_crazy_peter_parker", breakpoints: true, sqlSha256: "9420cb93e4938485b372a3f8ae86123536c783b17324ebdeca84df9a0c1c9dc9" }),
  Object.freeze({ idx: 20, version: "7", when: 1783848394216, tag: "0020_melted_dreadnoughts", breakpoints: true, sqlSha256: "bb1995d0ebd4b4578b7a3f2a770f1cd1a9664fb32085032c66994fdb7444de27" }),
  Object.freeze({ idx: 21, version: "7", when: 1783848985332, tag: "0021_luxuriant_hellcat", breakpoints: true, sqlSha256: "16086741ba84f6a6d63b7f0a1f4e55f8f35cfff8a7223640f8c5cf2d8db30e19" }),
  Object.freeze({ idx: 22, version: "7", when: 1783854893806, tag: "0022_oval_kinsey_walden", breakpoints: true, sqlSha256: "58cce0b052f42b2ebe90e46c24e7693362fc582700b8a78e9dd75e7665387350" }),
  Object.freeze({ idx: 23, version: "7", when: 1783856617705, tag: "0023_huge_sharon_ventura", breakpoints: true, sqlSha256: "9d583afe187a228a3385bd856199292ca04539283e82d593a6dd0ae4a7ca35f1" }),
  Object.freeze({ idx: 24, version: "7", when: 1783856878898, tag: "0024_fine_shadowcat", breakpoints: true, sqlSha256: "9bb044a47730b7a6c8f0df41f153f7ececc1b07e63c77ab1e6a90ecdae9d8e66" }),
  Object.freeze({ idx: 25, version: "7", when: 1783858564303, tag: "0025_legal_christian_walker", breakpoints: true, sqlSha256: "be39966a7486c5758bfc420b524007fd3f0d2a97b2c73dd6f203021122859f9f" }),
  Object.freeze({ idx: 26, version: "7", when: 1783873705247, tag: "0026_auth_recovery_ceremony", breakpoints: true, sqlSha256: "4df759b335e759fed3883d99b03a79b22122ae154fde5270290acc0c5fb5512e" }),
  Object.freeze({ idx: 27, version: "7", when: 1783873741763, tag: "0027_public_miracleman", breakpoints: true, sqlSha256: "56d3a1875c24d60ebabd3955071bb973c7bca0e2bf4a2569f17ec77e21f134a5" }),
  Object.freeze({ idx: 28, version: "7", when: 1783873999848, tag: "0028_cheerful_kang", breakpoints: true, sqlSha256: "6a3d758ddc5a08b3bdf15d430d81e2177e69e3a7257a8daa2a4c61014c1668f8" }),
  Object.freeze({ idx: 29, version: "7", when: 1783874811273, tag: "0029_slow_bulldozer", breakpoints: true, sqlSha256: "48a771007e079397b253fa9b5586828f98cdeeea2f8ce02d0c9ea9d0faeff024" }),
  Object.freeze({ idx: 30, version: "7", when: 1783875429122, tag: "0030_goofy_roxanne_simpson", breakpoints: true, sqlSha256: "7f3a9ee11a7af7041868265fa59264bd713609d2f2ec5f132f154549f5b45fc9" }),
  Object.freeze({ idx: 31, version: "7", when: 1783876406202, tag: "0031_easy_deathstrike", breakpoints: true, sqlSha256: "bba2a0a67f6e1f83ca5c4a1d5a2151cf6d74b3d050da5456f64bd3a3a263ef11" }),
  Object.freeze({ idx: 32, version: "7", when: 1783876804870, tag: "0032_short_green_goblin", breakpoints: true, sqlSha256: "ad353e63c2e45c5b46de0266b5f265f20e475771093cc8575aa49abe870b04e5" }),
  Object.freeze({ idx: 33, version: "7", when: 1783877974777, tag: "0033_project_review_ledger_fencing", breakpoints: true, sqlSha256: "971731ba79ee91b9005315c79b26f82f726188cedad91b2dcc70e8fda21a23cb" }),
  Object.freeze({ idx: 34, version: "7", when: 1783879000000, tag: "0034_fallback_authority_delete_guard", breakpoints: true, sqlSha256: "ca1ee5a9fe728c83f9d8af42b11ad3a9467d5a93af779a79420f57cdc31d6f73" }),
  Object.freeze({ idx: 35, version: "7", when: 1783879635101, tag: "0035_official_runner_fairness", breakpoints: true, sqlSha256: "5248e2c78a8152a4994f9e286d16c1577820ef8dda40db1b8df7058eff7abbe6" }),
  Object.freeze({ idx: 36, version: "7", when: 1783882396594, tag: "0036_late_tony_stark", breakpoints: true, sqlSha256: "7dcb3eb39070f03ab03a082d6f26ce3acb70a39bf07dad729d48b25c1a205c09" }),
  Object.freeze({ idx: 37, version: "7", when: 1783885368181, tag: "0037_solid_chameleon", breakpoints: true, sqlSha256: "bb12a61adf3483d76a3a13ce9441ef6c1e40d261f047dbfc0c3628db6625ddb2" }),
  Object.freeze({ idx: 38, version: "7", when: 1783886411752, tag: "0038_cuddly_lizard", breakpoints: true, sqlSha256: "e9093eaa6a37982fc5b73ac48b3794f86174a35f3d2fc0bb77af7e967b46befa" }),
  Object.freeze({ idx: 39, version: "7", when: 1783886432731, tag: "0039_clever_firestar", breakpoints: true, sqlSha256: "f85786dc3c7bcfd62dce3a962362f09f84f5992dea23717d1367ac34792307ea" }),
  Object.freeze({ idx: 40, version: "7", when: 1783888601415, tag: "0040_lucky_paladin", breakpoints: true, sqlSha256: "68f2902984454f70c962efaaad218921b9dcc25f1a607f15e20c367bc8906917" }),
  Object.freeze({ idx: 41, version: "7", when: 1783944425546, tag: "0041_cool_namor", breakpoints: true, sqlSha256: "475dda68bdabda95896275390987bddf6fd06808c7979b4fb342a1e657f52a36" }),
  Object.freeze({ idx: 42, version: "7", when: 1783967602842, tag: "0042_motionless_black_knight", breakpoints: true, sqlSha256: "1099ed0cd49c348989cd7b3bfd1cd61c096e3fa71d72fee31f12cd88f595c6ae" }),
  Object.freeze({ idx: 43, version: "7", when: 1783972224741, tag: "0043_uneven_gauntlet", breakpoints: true, sqlSha256: "9e7a5c27a55fc2c733fa570663d165df08dda4284ba65d0308bb72aec96df5ff" }),
  Object.freeze({ idx: 44, version: "7", when: 1783972886889, tag: "0044_moaning_living_mummy", breakpoints: true, sqlSha256: "3cf32b4aa90e5650aa633a3f8fb8cf1308394907a9076d97947b92c598359ff9" }),
  Object.freeze({ idx: 45, version: "7", when: 1783978027595, tag: "0045_right_mother_askani", breakpoints: true, sqlSha256: "851c99138c43b3383fc892886def4d9c6096c20a208376c44bda9261631a3009" }),
  Object.freeze({ idx: 46, version: "7", when: 1783979163003, tag: "0046_majestic_sebastian_shaw", breakpoints: true, sqlSha256: "a9515ea286c86aa590fa64627805c9ff1b82bdadf2b6300e01b2dc28fd0477d9" }),
  Object.freeze({ idx: 47, version: "7", when: 1783979995326, tag: "0047_odd_drax", breakpoints: true, sqlSha256: "3cd3a9b2360c6de3c20e579a87f52db2f1df49c71d35f8aa002acdf9da41fc19" }),
  Object.freeze({ idx: 48, version: "7", when: 1783981446254, tag: "0048_flat_turbo", breakpoints: true, sqlSha256: "4db92107b6c92787bda75f8c193281a4a8631e96effc0558bc7517fb5176b5be" }),
  Object.freeze({ idx: 49, version: "7", when: 1783983319316, tag: "0049_chief_ghost_rider", breakpoints: true, sqlSha256: "36014c7ae1d836f536a622ae592f09ad7c94d79f6dc576e2e74c21a32c1053c4" }),
  Object.freeze({ idx: 50, version: "7", when: 1783983475905, tag: "0050_public_portfolio_selection_guard_fix", breakpoints: true, sqlSha256: "f7395723fdbabcfe3bbc59d24a63aa2ea64e184d21b09ffa109d7d1337766ed6" }),
  Object.freeze({ idx: 51, version: "7", when: 1783986238812, tag: "0051_privacy_lifecycle_guards", breakpoints: true, sqlSha256: "155b1f5e342f9ee520befc09ff485d1540543cea1d4afb58c5978e9c2e077afd" }),
  Object.freeze({ idx: 52, version: "7", when: 1783986884433, tag: "0052_public_portfolio_project_snapshots", breakpoints: true, sqlSha256: "e2fedf891f9af229ae9f43110785a84b14ee03ad6dc7edd0ebc53b8e75743857" }),
  Object.freeze({ idx: 53, version: "7", when: 1784005684888, tag: "0053_community_moderation_idempotency", breakpoints: true, sqlSha256: "8d635c41298b402963715b92239263cb1281371de3e6dca9d51507ea6d58c474" }),
  Object.freeze({ idx: 54, version: "7", when: 1784106533927, tag: "0054_exam_autosave_idempotency", breakpoints: true, sqlSha256: "d968d787da20c5b8c012c9a91e89e06366cbf189136ede0c639d03cedac32375" }),
  Object.freeze({ idx: 55, version: "7", when: 1784535895071, tag: "0055_boring_sabretooth", breakpoints: true, sqlSha256: "1c39fbf84324895bfca5d63ff3e62f3d434a8bd5a6550356bdb379b47011702a" }),
  Object.freeze({ idx: 56, version: "7", when: 1784549446390, tag: "0056_durable_upload_receipts", breakpoints: true, sqlSha256: "77b6d391c592ce535121e5dadedfe4a6ba19f340425c5aeb18a76b6f766a5a42" }),
  Object.freeze({ idx: 57, version: "7", when: 1784741687704, tag: "0057_mail_outbox_reliability", breakpoints: true, sqlSha256: "79042548669273821503ba86fd2d8118c1e943270e3dfee9a8ceaa4eb9bb79e1" }),
  Object.freeze({ idx: 58, version: "7", when: 1784753601960, tag: "0058_mail_delivery_scope", breakpoints: true, sqlSha256: "a9f9dacfa7f836ce02ec1b5a19b8a798c510330495031c28eae2d217e91584dd" }),
  Object.freeze({ idx: 59, version: "7", when: 1784835583629, tag: "0059_mail_delivery_scope_contract", breakpoints: true, sqlSha256: "4ba5deecc8b1bad7bf089d84ee32b22deda5c0bd9d362d13f08d7523ccf6dd7e" }),
  Object.freeze({ idx: 60, version: "7", when: 1784898036015, tag: "0060_mail_outbox_payload_immutability", breakpoints: true, sqlSha256: "704683f9e3fe7b628694efe5761fc981373fbdbbc1664e1ad8a2c1af789139e6" }),
  Object.freeze({ idx: 61, version: "7", when: 1784921980000, tag: "0061_mail_worker_outbox_privileges", breakpoints: true, sqlSha256: "103b14bc21213df916eb1deb565a7ba3beed4e149f02070e4b5d931ae135e608" }),
  Object.freeze({ idx: 62, version: "7", when: 1784925600000, tag: "0062_mail_outbox_retention_redaction", breakpoints: true, sqlSha256: "98cd8b0fd5b57822bab9a3793094e738d926d5dab8a2dc700f89037bd0cbc13b" }),
  Object.freeze({ idx: 63, version: "7", when: 1784929200000, tag: "0063_mail_outbox_redaction_fence_release", breakpoints: true, sqlSha256: "b1ff8b57084dcaf6e677aa5eb73d3f0e1156dca406d50f547c8d2c5590260ea2" }),
  Object.freeze({ idx: 64, version: "7", when: 1784932800000, tag: "0064_mail_outbox_dispatch_binding", breakpoints: true, sqlSha256: "c6f057b8726602c3e6330c68a5a97e5698a1451b5b0d6ca2e3020db4f35975b9" }),
]);

export const REVIEWED_MIGRATION_LEDGER_SHA256 =
  "9e7d11aa21ee3813f7ac41c99a624ea918eaeab5e3e0e0b0f35cc96d5dc77b61";

validateReviewedMigrationLedger(REVIEWED_MIGRATION_LEDGER, "CONTRACT_INVALID");
if (
  reviewedMigrationLedgerSha256(REVIEWED_MIGRATION_LEDGER) !==
  REVIEWED_MIGRATION_LEDGER_SHA256
) {
  fail("CONTRACT_DIGEST_MISMATCH");
}

function readJournal(journalPath) {
  try {
    const metadata = lstatSync(journalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("REPOSITORY_JOURNAL_MISMATCH");
    }
    return JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (error) {
    if (error instanceof ReviewedMigrationLedgerError) throw error;
    fail("REPOSITORY_JOURNAL_MISMATCH", error);
  }
}

function journalEntryMatches(entry, reviewed) {
  return (
    exactKeys(entry, JOURNAL_ENTRY_KEYS) &&
    entry.idx === reviewed.idx &&
    entry.version === reviewed.version &&
    entry.when === reviewed.when &&
    entry.tag === reviewed.tag &&
    entry.breakpoints === reviewed.breakpoints
  );
}

export function verifyReviewedMigrationRepository({
  drizzleDirectory = DEFAULT_DRIZZLE_DIRECTORY,
} = {}) {
  const resolvedDirectory = path.resolve(fileURLToPathIfNeeded(drizzleDirectory));
  const journal = readJournal(
    path.join(resolvedDirectory, "meta", "_journal.json"),
  );
  if (
    !exactKeys(journal, JOURNAL_ROOT_KEYS) ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== REVIEWED_MIGRATION_LEDGER.length ||
    !journal.entries.every((entry, index) =>
      journalEntryMatches(entry, REVIEWED_MIGRATION_LEDGER[index]),
    )
  ) {
    fail("REPOSITORY_JOURNAL_MISMATCH");
  }

  let actualSqlNames;
  try {
    actualSqlNames = readdirSync(resolvedDirectory, {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() && /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    fail("REPOSITORY_SQL_INVENTORY_MISMATCH", error);
  }
  const expectedSqlNames = REVIEWED_MIGRATION_LEDGER.map(
    (entry) => `${entry.tag}.sql`,
  );
  if (
    actualSqlNames.length !== expectedSqlNames.length ||
    actualSqlNames.some((name, index) => name !== expectedSqlNames[index])
  ) {
    fail("REPOSITORY_SQL_INVENTORY_MISMATCH");
  }

  for (const entry of REVIEWED_MIGRATION_LEDGER) {
    const migrationPath = path.join(resolvedDirectory, `${entry.tag}.sql`);
    let bytes;
    try {
      const metadata = lstatSync(migrationPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail("REPOSITORY_SQL_DIGEST_MISMATCH");
      }
      bytes = readFileSync(migrationPath);
    } catch (error) {
      if (error instanceof ReviewedMigrationLedgerError) throw error;
      fail("REPOSITORY_SQL_DIGEST_MISMATCH", error);
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== entry.sqlSha256) {
      fail("REPOSITORY_SQL_DIGEST_MISMATCH");
    }
  }

  const tail = REVIEWED_MIGRATION_LEDGER.at(-1);
  return Object.freeze({
    entryCount: REVIEWED_MIGRATION_LEDGER.length,
    ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    tailIndex: tail.idx,
    tailTag: tail.tag,
  });
}

function fileURLToPathIfNeeded(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

function validateAppliedRows(rows) {
  if (!Array.isArray(rows)) fail("DATABASE_LEDGER_QUERY_INVALID");
  if (rows.length > REVIEWED_MIGRATION_LEDGER.length) {
    fail("DATABASE_LEDGER_EXTRA");
  }

  let previousId = -1n;
  for (const [position, row] of rows.entries()) {
    const reviewed = REVIEWED_MIGRATION_LEDGER[position];
    let id;
    try {
      if (!/^[0-9]+$/u.test(String(row?.id ?? ""))) {
        fail("DATABASE_LEDGER_MISMATCH");
      }
      id = BigInt(row.id);
    } catch (error) {
      if (error instanceof ReviewedMigrationLedgerError) throw error;
      fail("DATABASE_LEDGER_MISMATCH", error);
    }
    if (
      id <= previousId ||
      row?.hash !== reviewed.sqlSha256 ||
      String(row?.created_at ?? "") !== String(reviewed.when)
    ) {
      fail("DATABASE_LEDGER_MISMATCH");
    }
    previousId = id;
  }
}

export async function verifyAppliedMigrationLedger(
  client,
  { requireComplete = false } = {},
) {
  let presence;
  try {
    presence = await client.query(`
      select pg_catalog.to_regclass(
               'drizzle.__drizzle_migrations'
             ) is not null reviewed_migration_journal_present`);
  } catch (error) {
    fail("DATABASE_LEDGER_QUERY_FAILED", error);
  }
  const present = presence?.rows?.[0]?.reviewed_migration_journal_present;
  if (presence?.rows?.length !== 1 || typeof present !== "boolean") {
    fail("DATABASE_LEDGER_QUERY_INVALID");
  }
  if (!present) {
    if (requireComplete) fail("DATABASE_LEDGER_INCOMPLETE");
    return Object.freeze({
      appliedCount: 0,
      complete: false,
      ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    });
  }

  let result;
  try {
    result = await client.query(`
      select journal.id::text id,
             journal.hash::text hash,
             journal.created_at::text created_at
        from drizzle.__drizzle_migrations journal
       order by journal.id
       /* reviewed_full_migration_journal_rows */`);
  } catch (error) {
    fail("DATABASE_LEDGER_QUERY_FAILED", error);
  }
  validateAppliedRows(result?.rows);
  const appliedCount = result.rows.length;
  if (requireComplete && appliedCount !== REVIEWED_MIGRATION_LEDGER.length) {
    fail("DATABASE_LEDGER_INCOMPLETE");
  }
  return Object.freeze({
    appliedCount,
    complete: appliedCount === REVIEWED_MIGRATION_LEDGER.length,
    ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
  });
}
