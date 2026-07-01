import LogoutButton from './LogoutButton';

// Protected by middleware (redirects to /login without a session cookie).
export default function DashboardPage() {
  return (
    <main className="dash">
      <header>
        <h1>Dashboard</h1>
        <LogoutButton />
      </header>
      <p>
        You’re signed in. Document upload with live ingestion progress, the retrieval playground,
        and the publish flow arrive in the next issues.
      </p>
    </main>
  );
}
