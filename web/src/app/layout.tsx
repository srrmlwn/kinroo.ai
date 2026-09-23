import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://kinroo.ai"),
  title: "kinroo.ai",
  description: "Natural language on top of your Google Calendar.",
  openGraph: {
    title: "kinroo.ai",
    description: "Natural language on top of your Google Calendar.",
    images: ["/brand/banner.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "kinroo.ai",
    description: "Natural language on top of your Google Calendar.",
    images: ["/brand/banner.jpg"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
