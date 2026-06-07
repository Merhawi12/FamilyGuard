import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import AlertBell from './AlertBell';

export default function Layout() {
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 min-h-screen">
        <header className="bg-white border-b border-gray-100 px-8 py-4 flex justify-end">
          <AlertBell />
        </header>
        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
