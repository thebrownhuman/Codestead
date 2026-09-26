import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: 96,
          background: "#f3f5ef",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 40 }}>
          <div
            style={{
              width: 84,
              height: 84,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#17462d",
              borderRadius: 24,
            }}
          >
            <svg fill="none" height="46" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} viewBox="0 0 24 24" width="46">
              <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
              <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
            </svg>
          </div>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 800, color: "#172019", letterSpacing: -2 }}>Codestead</div>
        </div>
        <div style={{ display: "flex", fontSize: 34, color: "#59645a", maxWidth: 900 }}>
          Build skills that stay. A private, adaptive learning studio for coding, DSA, web, and AI.
        </div>
      </div>
    ),
    { ...size },
  );
}
