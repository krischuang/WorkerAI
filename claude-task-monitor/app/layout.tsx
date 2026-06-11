import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Nav } from "./_components/Nav";
import { GlobalKeyboardShortcuts } from "./_components/GlobalKeyboardShortcuts";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claude Task Monitor",
  description: "Local-first AI task management",
};

// Inline script that runs before first paint to set data-theme on <html>.
// Prevents flash of wrong theme (FOUC) by resolving the preference synchronously.
const themeScript = `(function(){try{var p=localStorage.getItem('theme')||'system';var h=document.documentElement;var dark=window.matchMedia('(prefers-color-scheme:dark)').matches;if(p==='dark')h.setAttribute('data-theme','dark');else if(p==='light')h.setAttribute('data-theme','light');else h.setAttribute('data-theme',dark?'dark':'light');}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950 transition-colors duration-200">
        <Nav />
        <GlobalKeyboardShortcuts />
        {/* pt-12 compensates for the fixed mobile top bar; removed on md+ */}
        <main className="flex-1 overflow-auto pt-12 md:pt-0">{children}</main>
      </body>
    </html>
  );
}
