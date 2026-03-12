import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const cookieStore = await cookies();
  const hasAuth = cookieStore.get('auth_token')?.value || cookieStore.get('refresh_token')?.value;
  redirect(hasAuth ? '/dashboard' : '/login');
}
