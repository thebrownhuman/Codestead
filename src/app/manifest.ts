import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Codestead",
    short_name: "Codestead",
    description: "Build skills that stay with a private, adaptive learning studio for coding, DSA, web, and AI.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f5ef",
    theme_color: "#17462d",
    icons: [
      { src: "/icon", sizes: "32x32", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
