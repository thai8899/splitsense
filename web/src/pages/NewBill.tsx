import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { api, ApiError, tokens, type ProcessStage } from '../lib/api';
import { penFor, prepareReceiptFile } from '../lib/format';

const STAGES: Array<{ stage: ProcessStage; label: string }> = [
  { stage: 'reading_receipt', label: 'Read the receipt' },
  { stage: 'verifying_math', label: 'Check the math' },
  { stage: 'assigning_items', label: 'Match items to people' },
  { stage: 'computing_shares', label: 'Work out exact shares' },
];

const EXAMPLE =
  'Ada and I split the wings. I had the jollof, Ada had the salmon and the water. Tolu and Kemi shared the pizza, Kemi had the salad. Tolu had 2 of the beers, I had 1. We all shared dessert. Add a 20% tip.';

export function NewBill() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [hostName, setHostName] = useState('');
  const [hostEmail, setHostEmail] = useState('');
  const [friendDraft, setFriendDraft] = useState('');
  const [friends, setFriends] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [useSample, setUseSample] = useState(false);
  const [sampleAvailable, setSampleAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<ProcessStage | null>(null);
  const [stageMessage, setStageMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then((c) => setSampleAvailable(c.sampleReceiptAvailable)).catch(() => setSampleAvailable(false));
  }, []);

  useEffect(() => {
    if (!file || file.type === 'application/pdf') {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const people = [hostName.trim() || 'You', ...friends];

  function addFriend(raw: string) {
    const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    setFriends((current) => {
      const next = [...current];
      for (const name of names) {
        const taken = [hostName.trim(), ...next].some((n) => n.toLowerCase() === name.toLowerCase());
        if (!taken && next.length < 11) next.push(name.slice(0, 40));
      }
      return next;
    });
    setFriendDraft('');
  }

  function onFriendKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addFriend(friendDraft);
    } else if (event.key === 'Backspace' && friendDraft === '' && friends.length > 0) {
      setFriends((f) => f.slice(0, -1));
    }
  }

  function trySample() {
    setUseSample(true);
    setFile(null);
    if (!hostName) setHostName('Femi');
    if (friends.length === 0) setFriends(['Ada', 'Tolu', 'Kemi']);
    if (!instructions) setInstructions(EXAMPLE);
    if (!title) setTitle('Friday dinner');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const allFriends = friendDraft.trim() ? [...friends, friendDraft.trim()] : friends;
    if (!hostName.trim()) return setError('Add your name so we know whose share is already paid.');
    if (allFriends.length === 0) return setError('Add at least one friend to split with.');
    if (!file && !useSample) return setError('Add a photo of the receipt, or try the sample receipt.');

    const form = new FormData();
    form.set('hostName', hostName.trim());
    if (hostEmail.trim()) form.set('hostPayPalEmail', hostEmail.trim());
    form.set('friends', JSON.stringify(allFriends));
    form.set('instructions', instructions);
    form.set('title', title);
    if (useSample) form.set('useSample', 'true');
    else if (file) form.set('receipt', await prepareReceiptFile(file), file.type === 'application/pdf' ? 'receipt.pdf' : 'receipt.jpg');

    setRunning(true);
    setStage('reading_receipt');
    try {
      let done = false;
      await api.process(form, (evt) => {
        if (evt.type === 'progress') {
          setStage(evt.stage);
          setStageMessage(evt.message);
        } else if (evt.type === 'result') {
          done = true;
          tokens.set(evt.billId, evt.adminToken);
          navigate(`/bills/${evt.billId}?token=${encodeURIComponent(evt.adminToken)}`);
        } else {
          done = true;
          setError(evt.error);
        }
      });
      if (!done) setError('The connection closed before the split finished. Try again.');
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setRunning(false);
    }
  }

  const stageIndex = stage ? STAGES.findIndex((s) => s.stage === stage) : -1;

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 lg:grid-cols-[1.1fr_0.9fr] lg:py-16">
      <section>
        <h1 className="max-w-xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
          Snap the receipt. Say who had what. Everyone pays their exact share.
        </h1>
        <p className="mt-4 max-w-lg text-lg text-ink-soft">
          You covered dinner. SplitSense reads the bill, splits tax and tip to the cent, and sends each friend a PayPal link for what they owe.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-6" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-semibold">Your name</span>
              <input
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                maxLength={40}
                autoComplete="given-name"
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5"
                placeholder="Femi"
                disabled={running}
              />
            </label>
            <label className="block">
              <span className="text-sm font-semibold">What was it?</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5"
                placeholder="Friday dinner"
                disabled={running}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-semibold">Your PayPal email (optional)</span>
            <span className="block text-sm text-ink-soft">Friends pay you directly. Leave it blank to collect into the demo merchant account.</span>
            <input
              type="email"
              value={hostEmail}
              onChange={(e) => setHostEmail(e.target.value)}
              maxLength={254}
              autoComplete="email"
              inputMode="email"
              className="mt-2 w-full rounded-md border border-rule bg-paper px-3 py-2.5"
              placeholder="you@example.com"
              disabled={running}
            />
          </label>

          <div>
            <label htmlFor="friend-input" className="text-sm font-semibold">
              Who are you splitting with?
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-rule bg-paper px-2 py-2 focus-within:outline-3 focus-within:outline-pay">
              {friends.map((name) => (
                <span key={name} className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-sm font-medium" style={{ background: penFor(people, name) }}>
                  {name}
                  <button
                    type="button"
                    onClick={() => setFriends((f) => f.filter((n) => n !== name))}
                    className="grid size-5 place-items-center rounded-full hover:bg-ink/10"
                    aria-label={`Remove ${name}`}
                    disabled={running}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                id="friend-input"
                value={friendDraft}
                onChange={(e) => setFriendDraft(e.target.value)}
                onKeyDown={onFriendKey}
                onBlur={() => addFriend(friendDraft)}
                className="min-w-32 flex-1 bg-transparent px-1 py-1 outline-none"
                placeholder={friends.length ? 'Add another' : 'Type a name, press Enter'}
                disabled={running}
              />
            </div>
          </div>

          <div>
            <span className="text-sm font-semibold">Receipt</span>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="rounded-md border border-ink px-4 py-2.5 font-semibold hover:bg-ink hover:text-paper"
                disabled={running}
              >
                {file ? 'Change photo' : 'Add receipt photo'}
              </button>
              {sampleAvailable && (
                <button type="button" onClick={trySample} className="px-1 py-2.5 font-medium text-pay underline underline-offset-4" disabled={running}>
                  Try the sample receipt
                </button>
              )}
              <span className="text-sm text-ink-soft">
                {useSample ? 'Using the sample receipt' : file ? file.name : 'JPEG, PNG, WebP or PDF'}
              </span>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setFile(picked);
                if (picked) setUseSample(false);
              }}
            />
          </div>

          <label className="block">
            <span className="text-sm font-semibold">Who had what?</span>
            <span className="block text-sm text-ink-soft">Write it the way you’d text it. Anything you don’t mention is split evenly.</span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              maxLength={2000}
              className="mt-2 w-full rounded-md border border-rule bg-paper px-3 py-2.5"
              placeholder={EXAMPLE}
              disabled={running}
            />
          </label>

          {error && (
            <p role="alert" className="rounded-md bg-bad/10 p-3 text-sm text-bad">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={running}
            className="inline-flex items-center gap-3 rounded-md bg-ink px-6 py-3.5 text-lg font-semibold text-paper hover:bg-ink/90 disabled:opacity-70"
          >
            {running && <Spinner />}
            {running ? 'Splitting…' : 'Split the bill'}
          </button>
        </form>
      </section>

      <aside className="lg:pt-4" aria-live="polite">
        {running ? (
          <div className="receipt rounded-t-sm p-7">
            <p className="font-sans text-lg font-semibold">{stageMessage || 'Starting…'}</p>
            <ol className="mt-5 space-y-3 font-sans">
              {STAGES.map((s, i) => (
                <li key={s.stage} className={`flex items-center gap-3 ${i > stageIndex ? 'text-ink-soft/60' : ''}`}>
                  <span
                    className={`grid size-7 place-items-center rounded-full text-sm font-semibold ${
                      i < stageIndex ? 'bg-good text-paper' : i === stageIndex ? 'bg-pen-1 text-ink' : 'border border-rule'
                    }`}
                  >
                    {i < stageIndex ? '✓' : i === stageIndex ? <Spinner className="size-3.5" /> : i + 1}
                  </span>
                  {s.label}
                </li>
              ))}
            </ol>
            <p className="mt-6 font-sans text-sm text-ink-soft">Usually 10–20 seconds. The AI double-checks its own arithmetic before anything is charged.</p>
          </div>
        ) : preview ? (
          <img src={preview} alt="Your receipt" className="max-h-[70vh] w-full rounded-sm object-contain shadow-lg" />
        ) : useSample ? (
          <img src="/api/sample-receipt" alt="Sample receipt from Saguaro Social Kitchen" className="max-h-[70vh] w-full rounded-sm object-contain shadow-lg" />
        ) : (
          <HowItWorks />
        )}
      </aside>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ['Photograph the receipt', 'Any angle, any restaurant. PDFs from delivery apps work too.'],
    ['Describe who had what', '“Ada and I split the wings, Tolu had two beers.” Plain words are enough.'],
    ['Check the highlighted bill', 'Every line is marked in each friend’s colour. Tap to fix anything.'],
    ['Send the links', 'Each friend pays their exact share with PayPal, Venmo or card. You watch it land live.'],
  ];
  return (
    <ol className="receipt space-y-5 rounded-t-sm p-7 font-sans">
      {steps.map(([title, body], i) => (
        <li key={title} className="grid grid-cols-[2rem_1fr] gap-3">
          <span className="marker px-1 font-mono text-lg font-semibold" style={{ ['--pen' as string]: `var(--color-pen-${i + 1})` }}>
            {i + 1}
          </span>
          <div>
            <p className="font-semibold">{title}</p>
            <p className="text-sm text-ink-soft">{body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
