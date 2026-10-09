import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'A10',
  description: 'A10 financial intelligence for XAU/USD and US equity research.',
  icons: { icon: '/favicon.svg' }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
