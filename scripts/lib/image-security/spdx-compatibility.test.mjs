import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateSpdxDocument } from "./runtime-operations.mjs";

const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function minimizedRealReport(url, toolCreator) {
  const source = readJson(url);
  const describes = source.relationships.find((relationship) => (
    relationship.spdxElementId === "SPDXRef-DOCUMENT"
    && relationship.relationshipType === "DESCRIBES"
  ));
  const root = source.packages.find((entry) => entry.SPDXID === describes.relatedSpdxElement);
  const result = {
    spdxVersion: source.spdxVersion,
    dataLicense: source.dataLicense,
    SPDXID: source.SPDXID,
    name: source.name,
    documentNamespace: source.documentNamespace,
    creationInfo: {
      ...source.creationInfo,
      creators: source.creationInfo.creators
        .filter((creator) => !creator.startsWith("Tool: trivy-"))
        .concat(toolCreator ? [toolCreator] : []),
    },
    packages: [root],
    relationships: [describes],
  };
  if (source.files?.length) result.files = [source.files[0]];
  return result;
}

test("maintained SPDX 2.3.1 schema and license bytes match immutable provenance", () => {
  const schemaUrl = new URL("./schema/spdx-2.3.schema.json", import.meta.url);
  const licenseUrl = new URL("./schema/LICENSE.spdx-spec.txt", import.meta.url);
  const provenance = readJson(new URL("./schema/spdx-2.3.schema.provenance.json", import.meta.url));
  const schema = readFileSync(schemaUrl);
  const license = readFileSync(licenseUrl);

  assert.equal(provenance.commit, "6cb525045cf86fa173d093cdf0b2e7ad4faee42f");
  assert.equal(provenance.gitBlob, "d4d608e3e4502fd024bf62bfb860ac03599fe156");
  assert.equal(provenance.bytes, schema.length);
  assert.equal(provenance.sha256, sha256(schema));
  assert.equal(provenance.license.sha256, sha256(license));
  assert.match(provenance.source, new RegExp(provenance.commit));
});

test("minimized retained real Syft and Trivy 0.69.3-compatible SPDX reports pass", () => {
  const syft = minimizedRealReport(
    new URL("../../../docs/evidence/container-security/runner/runtime-security/c.spdx.json", import.meta.url),
  );
  const trivy = minimizedRealReport(
    new URL("../../../docs/evidence/container-security/app/sbom-scanner-b4881646a3f9-20260713.spdx.json", import.meta.url),
    "Tool: trivy-0.69.3",
  );

  assert.match(validateSpdxDocument(JSON.stringify(syft)).creationInfo.creators.join(","), /syft/i);
  assert.match(validateSpdxDocument(JSON.stringify(trivy)).creationInfo.creators.join(","), /trivy-0\.69\.3/);
});

test("SPDX files, snippets, external references, and omitted optional package fields are accepted", () => {
  const document = minimizedRealReport(
    new URL("../../../docs/evidence/container-security/runner/runtime-security/c.spdx.json", import.meta.url),
  );
  const file = document.files[0];
  delete document.packages[0].supplier;
  delete document.packages[0].licenseConcluded;
  delete document.packages[0].licenseDeclared;
  document.snippets = [{
    SPDXID: "SPDXRef-Snippet-example",
    snippetFromFile: file.SPDXID,
    ranges: [{
      startPointer: { reference: file.SPDXID, offset: 0 },
      endPointer: { reference: file.SPDXID, offset: 1 },
    }],
  }];
  document.externalDocumentRefs = [{
    externalDocumentId: "DocumentRef-upstream",
    spdxDocument: "https://example.invalid/upstream.spdx.json",
    checksum: { algorithm: "SHA256", checksumValue: "a".repeat(64) },
  }];
  document.relationships.push(
    {
      spdxElementId: file.SPDXID,
      relationshipType: "CONTAINS",
      relatedSpdxElement: "SPDXRef-Snippet-example",
    },
    {
      spdxElementId: document.packages[0].SPDXID,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "DocumentRef-upstream:SPDXRef-Package-library",
    },
  );

  const validated = validateSpdxDocument(JSON.stringify(document));
  assert.equal(validated.files.length, 1);
  assert.equal(validated.snippets.length, 1);
  assert.equal(validated.externalDocumentRefs.length, 1);
});
