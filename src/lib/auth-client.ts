"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [
    twoFactorClient({ twoFactorPage: "/two-factor" }),
    adminClient(),
  ],
});

export const { signIn, signOut, useSession } = authClient;
