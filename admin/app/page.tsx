import { redirect } from 'next/navigation';

// Middleware bounces this to /login when unauthenticated.
export default function Home() {
  redirect('/dashboard');
}
