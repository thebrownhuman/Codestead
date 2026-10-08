// Keep the existing section order and JSON projection. The private cursor
// columns are never serialized into the learner's NDJSON records.
export function keysetExportStatement(statement: string, category: string): string {
  const order = / order by ([a-z_]+\.[a-z_]+(?:,\s*[a-z_]+\.[a-z_]+)*) limit \$2 offset \$3$/.exec(statement);
  if (!order) throw new Error(`Export section ${category} has no pagination order.`);
  const keys = order[1].split(",").map((key) => key.trim());
  if (category === "activeSessionMetadata") keys.push("s.id");
  if (category === "projectRevisionFiles") keys.push("f.revision_id");
  if (category === "assessmentCorrections") keys.push("o.id", "m.id");
  const types = keys.map((key) => {
    if (key.endsWith(".local_date")) return "date";
    if (key.endsWith("_at")) return "timestamptz";
    if (/\.(position|ordinal|sequence|portfolio_version)$/.test(key)) return "bigint";
    return "text";
  });
  const columns = keys.map((_, index) => `export_key_${index}`);
  const projections = keys.map((key, index) => `${key}::${types[index]} as ${columns[index]}`);
  const base = statement.slice(0, order.index).replace(/\bas data\s+from\b/, `as data, ${projections.join(", ")} from`);
  if (base === statement.slice(0, order.index)) throw new Error(`Export section ${category} has no data projection.`);
  const cursor = columns.map((_, index) => `($3::jsonb ->> ${index})::${types[index]}`);
  // PostgreSQL's ascending order places nulls last. Use null-safe equality
  // for each prefix, including nullable timestamps in historical sections.
  const after = columns.map((column, index) => [
    ...columns.slice(0, index).map((prefix, prefixIndex) => `${prefix} is not distinct from ${cursor[prefixIndex]}`),
    `((${column} > ${cursor[index]}) or (${column} is null and ${cursor[index]} is not null))`,
  ].join(" and ")).map((predicate) => `(${predicate})`).join(" or ");
  return `select data, jsonb_build_array(${columns.join(", ")}) as export_cursor
    from (${base}) export_page
    where $3::jsonb is null or (${after})
    order by ${columns.join(", ")} limit $2`;
}
