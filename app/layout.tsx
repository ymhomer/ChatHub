import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatHub | Your private capture space",
  description: "Capture notes, links and files. Organize with commands and find them with captions and tags.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
