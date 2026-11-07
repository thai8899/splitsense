import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import './index.css';
import { BillPage } from './pages/BillPage';
import { NewBill } from './pages/NewBill';
import { PayShare } from './pages/PayShare';

function Shell() {
  return (
    <>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 pt-6">
        <Link to="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <img src="/favicon.svg" alt="" className="size-7" />
          SplitSense
        </Link>
        <span className="text-sm text-ink-soft">Payments by PayPal</span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<NewBill />} />
          <Route path="/bills/:id" element={<BillPage />} />
          <Route path="/pay/:id" element={<PayShare />} />
          <Route
            path="*"
            element={
              <div className="mx-auto max-w-lg px-5 py-24">
                <h1 className="text-2xl font-bold">There’s nothing at this address</h1>
                <Link to="/" className="mt-4 inline-block font-semibold text-pay underline underline-offset-4">
                  Split a bill
                </Link>
              </div>
            }
          />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </StrictMode>,
);
