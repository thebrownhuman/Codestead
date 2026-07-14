import { pool } from "../src/lib/db/client";
import { syncModuleProjectTemplates } from "../src/lib/projects/module-project-service";

syncModuleProjectTemplates()
  .then((report) => console.info(JSON.stringify({ event: "module_projects.synced", report })))
  .catch((error) => {
    console.error(JSON.stringify({
      event: "module_projects.sync_failed",
      code: error instanceof Error ? error.message : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
