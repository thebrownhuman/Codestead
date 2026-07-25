#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  assertBackupStatusMailAuthority0065PostgresProjection,
  backupStatusMailAuthority0065CiContract,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";

const readBytes = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url));
const read = (relativePath) => readBytes(relativePath).toString("utf8");
const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const expectedMigrationLedger = Object.freeze([
  ["0000_workable_deadpool.sql", "9a928d52f4f80a9e33938d90a14638bf4477c40bd0ad491b9caa03aca34ee146"],
  ["0001_nostalgic_thunderball.sql", "ae992bc2da0ac0598c65cd9efde2ecd2904f6548f6bd1eb7305ca3bc0bbd2a5f"],
  ["0002_nappy_alex_power.sql", "baea312a7aa67393238e54de4ea79b2a009db3a8fa4bcfcc78b02919e089a7db"],
  ["0003_colorful_gateway.sql", "81416b9ede2e50263a8e239938e255eb3e04536733722887bb090ea5ca753e99"],
  ["0004_windy_peter_quill.sql", "682ab52e6f9deb819707250fe20b756136e4d0392866bd78ba7beb68109a644a"],
  ["0005_nasty_puff_adder.sql", "f2093d48dc8d86570b899094599d1c2b96cc0c73139487eb01d160e5b1bac2a0"],
  ["0006_loving_carlie_cooper.sql", "c51bb630b22e0737c0cd34a20647176a2d0ede35945f83fc212809dc65192c0d"],
  ["0007_perpetual_shocker.sql", "3d8f446274edb41bbe0bec45b39744c5b7d1537e5644c8aade085d4184546918"],
  ["0008_abandoned_sumo.sql", "9e6c08f0ed6d44d63aa9d4ee75acd372ae5bf95e0fb1adc221ab241503b6303d"],
  ["0009_orange_miss_america.sql", "14fe757faa998f6c53bc07eef329cc106db281a424761271bd846b4063fe40a8"],
  ["0010_tricky_lord_tyger.sql", "4d40b69d280a867dc82b6d85f031fd05bd31e93ae1e01241ef89ce76d57adeb5"],
  ["0011_dapper_ghost_rider.sql", "03e50f27756eb76139098151289011d121917bd2aff42cfeb75d965ba7f692a2"],
  ["0012_appeal_immutability.sql", "8fa94a82633abc3993c3f48a4646ce5a4e70be1551be1c2c717777f4bd4eb286"],
  ["0013_milky_dark_beast.sql", "779c467fefefd4518666f61890a11efe6bce653dca34f48b67fe2d7ba5ba5e2e"],
  ["0014_curriculum_immutability.sql", "c1461f3e970b1da0b7203131cb3b6f1819146f5d7e4f92bb69556194f99e5d85"],
  ["0015_classy_sumo.sql", "4739c1366c8dd1c2520455167774ebf3a14c2a0057350023901455cec086c6b4"],
  ["0016_lovely_kinsey_walden.sql", "c5ecce582f7297c4fe5ff050f8e5b969e5756e2e3f769cecf41d877a2db62dc3"],
  ["0017_spooky_glorian.sql", "0a1a5f76ee48d330f7d854c7667e856894f38c7d36cb4dbee5def7ab29cb91e6"],
  ["0018_wealthy_loners.sql", "5c2418672c08ccca2039ce4ec4d58c64022c7288554a1d04adad576253297acd"],
  ["0019_crazy_peter_parker.sql", "9420cb93e4938485b372a3f8ae86123536c783b17324ebdeca84df9a0c1c9dc9"],
  ["0020_melted_dreadnoughts.sql", "bb1995d0ebd4b4578b7a3f2a770f1cd1a9664fb32085032c66994fdb7444de27"],
  ["0021_luxuriant_hellcat.sql", "16086741ba84f6a6d63b7f0a1f4e55f8f35cfff8a7223640f8c5cf2d8db30e19"],
  ["0022_oval_kinsey_walden.sql", "58cce0b052f42b2ebe90e46c24e7693362fc582700b8a78e9dd75e7665387350"],
  ["0023_huge_sharon_ventura.sql", "9d583afe187a228a3385bd856199292ca04539283e82d593a6dd0ae4a7ca35f1"],
  ["0024_fine_shadowcat.sql", "9bb044a47730b7a6c8f0df41f153f7ececc1b07e63c77ab1e6a90ecdae9d8e66"],
  ["0025_legal_christian_walker.sql", "be39966a7486c5758bfc420b524007fd3f0d2a97b2c73dd6f203021122859f9f"],
  ["0026_auth_recovery_ceremony.sql", "4df759b335e759fed3883d99b03a79b22122ae154fde5270290acc0c5fb5512e"],
  ["0027_public_miracleman.sql", "56d3a1875c24d60ebabd3955071bb973c7bca0e2bf4a2569f17ec77e21f134a5"],
  ["0028_cheerful_kang.sql", "6a3d758ddc5a08b3bdf15d430d81e2177e69e3a7257a8daa2a4c61014c1668f8"],
  ["0029_slow_bulldozer.sql", "48a771007e079397b253fa9b5586828f98cdeeea2f8ce02d0c9ea9d0faeff024"],
  ["0030_goofy_roxanne_simpson.sql", "7f3a9ee11a7af7041868265fa59264bd713609d2f2ec5f132f154549f5b45fc9"],
  ["0031_easy_deathstrike.sql", "bba2a0a67f6e1f83ca5c4a1d5a2151cf6d74b3d050da5456f64bd3a3a263ef11"],
  ["0032_short_green_goblin.sql", "ad353e63c2e45c5b46de0266b5f265f20e475771093cc8575aa49abe870b04e5"],
  ["0033_project_review_ledger_fencing.sql", "971731ba79ee91b9005315c79b26f82f726188cedad91b2dcc70e8fda21a23cb"],
  ["0034_fallback_authority_delete_guard.sql", "ca1ee5a9fe728c83f9d8af42b11ad3a9467d5a93af779a79420f57cdc31d6f73"],
  ["0035_official_runner_fairness.sql", "5248e2c78a8152a4994f9e286d16c1577820ef8dda40db1b8df7058eff7abbe6"],
  ["0036_late_tony_stark.sql", "7dcb3eb39070f03ab03a082d6f26ce3acb70a39bf07dad729d48b25c1a205c09"],
  ["0037_solid_chameleon.sql", "bb12a61adf3483d76a3a13ce9441ef6c1e40d261f047dbfc0c3628db6625ddb2"],
  ["0038_cuddly_lizard.sql", "e9093eaa6a37982fc5b73ac48b3794f86174a35f3d2fc0bb77af7e967b46befa"],
  ["0039_clever_firestar.sql", "f85786dc3c7bcfd62dce3a962362f09f84f5992dea23717d1367ac34792307ea"],
  ["0040_lucky_paladin.sql", "68f2902984454f70c962efaaad218921b9dcc25f1a607f15e20c367bc8906917"],
  ["0041_cool_namor.sql", "475dda68bdabda95896275390987bddf6fd06808c7979b4fb342a1e657f52a36"],
  ["0042_motionless_black_knight.sql", "1099ed0cd49c348989cd7b3bfd1cd61c096e3fa71d72fee31f12cd88f595c6ae"],
  ["0043_uneven_gauntlet.sql", "9e7a5c27a55fc2c733fa570663d165df08dda4284ba65d0308bb72aec96df5ff"],
  ["0044_moaning_living_mummy.sql", "3cf32b4aa90e5650aa633a3f8fb8cf1308394907a9076d97947b92c598359ff9"],
  ["0045_right_mother_askani.sql", "851c99138c43b3383fc892886def4d9c6096c20a208376c44bda9261631a3009"],
  ["0046_majestic_sebastian_shaw.sql", "a9515ea286c86aa590fa64627805c9ff1b82bdadf2b6300e01b2dc28fd0477d9"],
  ["0047_odd_drax.sql", "3cd3a9b2360c6de3c20e579a87f52db2f1df49c71d35f8aa002acdf9da41fc19"],
  ["0048_flat_turbo.sql", "4db92107b6c92787bda75f8c193281a4a8631e96effc0558bc7517fb5176b5be"],
  ["0049_chief_ghost_rider.sql", "36014c7ae1d836f536a622ae592f09ad7c94d79f6dc576e2e74c21a32c1053c4"],
  ["0050_public_portfolio_selection_guard_fix.sql", "f7395723fdbabcfe3bbc59d24a63aa2ea64e184d21b09ffa109d7d1337766ed6"],
  ["0051_privacy_lifecycle_guards.sql", "155b1f5e342f9ee520befc09ff485d1540543cea1d4afb58c5978e9c2e077afd"],
  ["0052_public_portfolio_project_snapshots.sql", "e2fedf891f9af229ae9f43110785a84b14ee03ad6dc7edd0ebc53b8e75743857"],
  ["0053_community_moderation_idempotency.sql", "8d635c41298b402963715b92239263cb1281371de3e6dca9d51507ea6d58c474"],
  ["0054_exam_autosave_idempotency.sql", "d968d787da20c5b8c012c9a91e89e06366cbf189136ede0c639d03cedac32375"],
  ["0055_boring_sabretooth.sql", "1c39fbf84324895bfca5d63ff3e62f3d434a8bd5a6550356bdb379b47011702a"],
  ["0056_durable_upload_receipts.sql", "77b6d391c592ce535121e5dadedfe4a6ba19f340425c5aeb18a76b6f766a5a42"],
  ["0057_mail_outbox_reliability.sql", "79042548669273821503ba86fd2d8118c1e943270e3dfee9a8ceaa4eb9bb79e1"],
  ["0058_mail_delivery_scope.sql", "a9f9dacfa7f836ce02ec1b5a19b8a798c510330495031c28eae2d217e91584dd"],
  ["0059_mail_delivery_scope_contract.sql", "4ba5deecc8b1bad7bf089d84ee32b22deda5c0bd9d362d13f08d7523ccf6dd7e"],
  ["0060_mail_outbox_payload_immutability.sql", "704683f9e3fe7b628694efe5761fc981373fbdbbc1664e1ad8a2c1af789139e6"],
  ["0061_mail_worker_outbox_privileges.sql", "103b14bc21213df916eb1deb565a7ba3beed4e149f02070e4b5d931ae135e608"],
  ["0062_mail_outbox_retention_redaction.sql", "98cd8b0fd5b57822bab9a3793094e738d926d5dab8a2dc700f89037bd0cbc13b"],
  ["0063_mail_outbox_redaction_fence_release.sql", "b1ff8b57084dcaf6e677aa5eb73d3f0e1156dca406d50f547c8d2c5590260ea2"],
  ["0064_mail_outbox_dispatch_binding.sql", "c6f057b8726602c3e6330c68a5a97e5698a1451b5b0d6ca2e3020db4f35975b9"],
  ["0065_backup_status_mail_authority.sql", "3aedb0c34774e187fd853808e78584c64b8828d346a94fc7b817cfc6235fb6a7"],
]);

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const harnessSource = read(
  "infra/tests/backup-status-mail-authority-0065.integration.mjs",
);
const normalPg17Runner = read(
  "infra/tests/database-least-privilege-integration.mjs",
);
const productionCompose = read("compose.yaml");
const scripts = packageManifest.scripts;
const {
  registrationScript,
  harnessScript,
  registrationCommand,
  harnessCommand,
} = backupStatusMailAuthority0065CiContract;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[harnessScript], harnessCommand);
assert.equal(
  scripts.check
    .split(" && ")
    .filter((command) => command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the 0065 registration guard exactly once",
);

const migrationNames = readdirSync(
  new URL("../../drizzle", import.meta.url),
)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 65)
  .sort();
const actualMigrationLedger = migrationNames.map((name) => [
  name,
  sha256(readBytes(`drizzle/${name}`)),
]);
assert.deepEqual(
  actualMigrationLedger,
  expectedMigrationLedger,
  "the complete ordered 0000..0065 migration name+SHA ledger changed",
);

const journalThrough0065 = journal.entries
  .filter((entry) => entry.idx <= 65)
  .sort((left, right) => left.idx - right.idx);
assert.equal(journalThrough0065.length, expectedMigrationLedger.length);
journalThrough0065.forEach((entry, expectedIndex) => {
  assert.equal(entry.idx, expectedIndex);
  assert.equal(entry.version, "7");
  assert.equal(entry.breakpoints, true);
  assert.equal(
    `${entry.tag}.sql`,
    expectedMigrationLedger[expectedIndex][0],
    `journal tag does not name migration ${expectedIndex}`,
  );
});
assert.deepEqual(journalThrough0065[64], {
  idx: 64,
  version: "7",
  when: 1784932800000,
  tag: "0064_mail_outbox_dispatch_binding",
  breakpoints: true,
});
assert.deepEqual(journalThrough0065[65], {
  idx: 65,
  version: "7",
  when: 1784936400000,
  tag: "0065_backup_status_mail_authority",
  breakpoints: true,
});

assert.match(harnessSource, /\["17", environment\.POSTGRES_17_BIN/u);
assert.match(harnessSource, /\["18", environment\.POSTGRES_18_BIN/u);
assert.match(
  harnessSource,
  /\.\.\/\.\.\/scripts\/lib\/disposable-loopback-port\.mjs/u,
);
assert.doesNotMatch(harnessSource, /net\.createServer|unusedLoopbackPort/u);
assert.match(harnessSource, /let primaryError;/u);
assert.match(harnessSource, /const cleanupErrors = \[\];/u);
assert.match(harnessSource, /primaryError\.cause \?\?= new AggregateError/u);
assert.match(harnessSource, /if \(primaryError\) throw primaryError;/u);
assert.doesNotMatch(
  harnessSource,
  /allowFailure:\s*true[\s\S]{0,120}pg_ctl|pg_ctl[\s\S]{0,120}allowFailure:\s*true/u,
);
assert.match(harnessSource, /let serverStartAttempted = false;/u);
assert.match(harnessSource, /"--log",\s*serverLog/u);
assert.match(
  harnessSource,
  /serverStartAttempted && existsSync\(postmasterPid\)/u,
);
assert.match(harnessSource, /"--no-wait",\s*"start"/u);
assert.match(harnessSource, /await waitForPostgres\(port\);/u);
assert.match(harnessSource, /BACKUP_STATUS_POSTGRES_PORT/u);
assert.match(harnessSource, /assert\.notEqual\(port, 5432/u);
assert.match(harnessSource, /SHOW server_version_num/u);

assert.match(normalPg17Runner, /databaseBackupReporterUrl:/u);
assert.match(
  normalPg17Runner,
  /url\("learncoding_backup_reporter", secret\("backup-reporter"/u,
);
assert.match(productionCompose, /DATABASE_BACKUP_REPORTER_URL_FILE:/u);
assert.match(productionCompose, /database_backup_reporter_url/u);

const postgresJob =
  workflow.match(
    /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
assertBackupStatusMailAuthority0065PostgresProjection(postgresJob);

console.log("backup-status-mail-authority-0065-registration-tests-ok");
