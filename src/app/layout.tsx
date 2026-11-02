import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FreeRouter",
  description: "A unified OpenAI-compatible gateway for free-tier models.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
