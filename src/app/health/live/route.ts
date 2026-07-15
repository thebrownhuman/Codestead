const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function GET() {
  return Response.json({ status: "ok" }, { headers });
}
