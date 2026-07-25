import { assertMailWriterInventory } from "./lib/mail-writer-inventory.mjs";

try {
  const report = assertMailWriterInventory(process.cwd());
  console.log(JSON.stringify({
    event: "mail_writer_inventory.ok",
    productionFiles: report.productionFiles.length,
    directWriters: report.directWriters.length,
    producers: report.producers.length,
    dispatchTemplates: report.dispatchEnabledTemplates.length,
  }));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Mail writer inventory failed with an unknown error.",
  );
  process.exitCode = 1;
}
