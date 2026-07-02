import Link from 'next/link';
import LogoutButton from './LogoutButton';

// Protected by middleware (redirects to /login without a session cookie).
export default function DashboardPage() {
  return (
    <main className="dash">
      <header>
        <h1>Dashboard</h1>
        <LogoutButton />
      </header>
      <p>You’re signed in. Start by uploading documents for your assistant to learn from.</p>
      <p>
        <Link href="/documents" className="primary-link">
          Upload documents →
        </Link>
      </p>
      <p>
        <Link href="/playground" className="primary-link">
          Test in the playground →
        </Link>
      </p>
      <p>
        <Link href="/settings" className="primary-link">
          Publish &amp; API keys →
        </Link>
      </p>
    </main>
  );
}
