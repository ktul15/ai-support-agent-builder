import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Chat with Your Business — Admin',
  description: 'Builder dashboard for your support assistant.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
