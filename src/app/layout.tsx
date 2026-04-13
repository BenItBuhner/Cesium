import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { AppClientProviders } from "@/components/app/AppClientProviders";
import { USER_PREFERENCES_STORAGE_KEY } from "@/lib/preferences";
import { THEME_STORAGE_KEY } from "@/lib/theme";
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
  title: "OpenCursor",
  description: "An open-source AI-powered IDE",
  applicationName: "OpenCursor",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "OpenCursor",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any", type: "image/x-icon" },
      { url: "/favicon.png", sizes: "256x256", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#191919" },
  ],
};

const themeBootstrap = `(()=>{try{var K=${JSON.stringify(THEME_STORAGE_KEY)};function pref(){var v=localStorage.getItem(K);return v==="light"||v==="dark"||v==="system"?v:"system"}function apply(){var p=pref();var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}apply();window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(pref()==="system")apply()})}catch(e){}})();`;
const preferencesBootstrap = `(()=>{try{var K=${JSON.stringify(USER_PREFERENCES_STORAGE_KEY)};var enabled=false;try{var raw=localStorage.getItem(K);var parsed=raw?JSON.parse(raw):null;enabled=!!(parsed&&parsed.experimentalIpadMode===true)}catch(e){}document.documentElement.setAttribute("data-experimental-ipad-mode",enabled?"true":"false");document.documentElement.classList.toggle("experimental-ipad-mode",enabled)}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {themeBootstrap}
        </Script>
        <Script id="preferences-bootstrap" strategy="beforeInteractive">
          {preferencesBootstrap}
        </Script>
        <AppClientProviders>{children}</AppClientProviders>
      </body>
    </html>
  );
}
