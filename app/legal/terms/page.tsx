import Link from 'next/link'
import { CONTACT_EMAIL, ENTITY, JURISDICTION, SITE_URL } from '../legal-info'

export const metadata = {
  title: 'Terms of Service',
  description: 'The rules for using Atlas: what you can do, what we promise, and what we do not.',
}

export default function Terms() {
  return (
    <>
      <h1 className="font-display text-[44px] leading-none text-ink">Terms of Service</h1>

      <div className="mt-8 rounded-plate border border-rule bg-raised p-6">
        <p className="mt-0 font-semibold text-ink">The short version</p>
        <ul>
          <li>Atlas is early software. It is free today, and we will not charge you without asking first.</li>
          <li>Your decks and your uploads stay yours. We host them so the product can work.</li>
          <li>
            AI-written questions can be wrong. Check a generated deck before you teach from it —
            this one is on you.
          </li>
          <li>
            You are responsible for your class: what you upload, and what your students are told
            before they join.
          </li>
          <li>There is no uptime guarantee. Do not make Atlas the only way an exam can happen.</li>
        </ul>
      </div>

      <h2>1. This agreement</h2>
      <p>
        These terms are between you and {ENTITY} (“we”, “us”), who operate Atlas at{' '}
        {SITE_URL}. Creating an account, hosting a
        session, or joining one means you accept them. If you do not, do not use Atlas.
      </p>
      <p>
        The <Link href="/legal/privacy">Privacy Policy</Link> is part of these terms and explains
        what we do with data. Read it, particularly section 4 if you plan to upload anything.
      </p>

      <h2>2. Who can use Atlas</h2>
      <ul>
        <li>
          <strong>An account is for an adult.</strong> You must be 18 or older to create one. If
          you are signing up for a school, you must be authorised to accept these terms for it.
        </li>
        <li>
          <strong>Students do not need an account</strong> and are not asked to accept anything.
          They join a room with a code and a nickname. The teacher who opened the room is
          responsible for the class inside it.
        </li>
      </ul>

      <h2>3. Your account</h2>
      <p>
        Keep your password to yourself and tell us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> if you think someone else has it.
        What happens under your account is treated as yours. One account is one person; do not
        share a login across a department.
      </p>

      <h2>4. What you upload, and who owns it</h2>
      <p>
        <strong>Your material stays yours.</strong> Decks, slides, questions, and uploaded files
        remain your property. You give us only the permission we need to run the product: to
        store your files, extract text from them, send that text to our AI provider when you ask
        for a generated deck, and display your deck to the class you show it to. Nothing else, and
        it ends when you delete the content or the account.
      </p>
      <p>By uploading, you confirm that:</p>
      <ul>
        <li>you have the right to use the material, including anyone else’s copyright in it;</li>
        <li>
          it does not contain other people’s personal data that you have no right to share — a
          class list, marked scripts, medical or disciplinary notes;
        </li>
        <li>it is not unlawful, and not something a school would call harassment or abuse.</li>
      </ul>
      <p>
        We do not read your decks and we do not use your material to train anything of our own.
        Our AI provider’s terms are a separate matter, covered in section 4 of the Privacy Policy
        — please read it before uploading anything you would not want processed on a free-tier
        API.
      </p>

      <h2>5. AI-generated questions</h2>
      <p>
        Atlas can write a deck from a topic or from your document. It will sometimes produce a
        question that is wrong, ambiguous, or marks the wrong option correct. That is a property of
        the technology, not a bug we expect to eliminate.
      </p>
      <p>
        <strong>
          Review every generated deck before you teach from it, and never use one for graded
          assessment without checking the answer key.
        </strong>{' '}
        The product deliberately puts a generated deck into your editor rather than straight into a
        live room, for exactly this reason. We are not responsible for a grade, an exam result, or
        a class outcome that depended on an unreviewed question.
      </p>

      <h2>6. Running a live class</h2>
      <p>When you open a room, you are the host, and you take on a few things with it:</p>
      <ul>
        <li>
          Tell your class what is happening before they join — that answers and scores are
          recorded, and that a nickname will appear on a screen. If you do not want real names on
          the projector, say so before you start.
        </li>
        <li>
          Where the law requires consent for a student’s data — including parental consent for
          anyone under 18 under India’s DPDP Act — obtaining it is the school’s job, not ours. We
          process what the class produces on your instruction.
        </li>
        <li>
          Do not use a session to collect anything sensitive. The nickname box is a nickname box.
        </li>
      </ul>
      <p>
        A room currently holds up to 300 participants. Anyone joining after that is turned away
        rather than degrading the class for everyone in it.
      </p>

      <h2>7. Things not to do</h2>
      <ul>
        <li>
          Do not try to break, overload, scrape, or reverse-engineer the service, or probe it for
          weaknesses without telling us first. Responsible reports are welcome at{' '}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </li>
        <li>
          Do not use someone else’s six-digit code to enter a class you were not invited to, or
          automate joining a room.
        </li>
        <li>
          Do not use Atlas to distribute malware, to harass anyone, or to host content that is
          illegal where you are.
        </li>
        <li>
          Do not resell Atlas, or run it as a service for other people, without our written
          agreement.
        </li>
      </ul>

      <h2>8. Price</h2>
      <p>
        <strong>Atlas is free to use right now.</strong> There is no billing in the product and we
        take no payment details. The plans described on the{' '}
        <Link href="/pricing">pricing page</Link> are what we intend to charge when paid plans
        exist; until then they describe nothing you are being billed for, and the limits listed
        against them are not all enforced yet.
      </p>
      <p>
        We will not start charging an existing account without telling you first and giving you the
        choice to stop. If and when a paid plan launches, its own billing terms will apply and will
        be presented before any payment.
      </p>

      <h2>9. Availability</h2>
      <p>
        Atlas is early software offered as it is. There is <strong>no uptime guarantee</strong>, no
        service level agreement, and no promise that a feature you rely on will still be here next
        term. We may change, suspend, or discontinue any part of it.
      </p>
      <p>
        Practical advice, not legal cover: have a fallback for a class that must happen. Do not make
        a live quiz the only route to a grade.
      </p>

      <h2>10. Ending it</h2>
      <p>
        You can stop at any time. Because there is no self-service account deletion in the app yet,
        email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address on the
        account and we will delete it, and everything attached to it, within 30 days.
      </p>
      <p>
        We can suspend or close an account that breaks section 7, that is being used to harm
        someone, or where we are required to. Where it is reasonable to warn you first, we will.
      </p>

      <h2>11. Liability</h2>
      <p>
        Atlas is provided “as is”, without warranties of any kind, to the extent the law allows. We
        do not warrant that it will be uninterrupted, error-free, or that AI-generated content will
        be accurate.
      </p>
      <p>
        We are not liable for indirect or consequential loss — lost teaching time, lost data you
        did not keep a copy of, a disrupted class, or an academic outcome. Where liability cannot
        be excluded, it is limited to the greater of what you have paid us in the previous twelve
        months (today, nothing) or ₹5,000.
      </p>
      <p>
        Nothing here limits liability for fraud, or for anything else the law does not permit us to
        limit.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These terms are governed by the laws of India. The courts at {JURISDICTION} have exclusive
        jurisdiction, except that either of us may seek urgent relief anywhere it is needed.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these terms. The date at the bottom of the page changes with them, and for
        anything material we will email account holders before it takes effect. Continuing to use
        Atlas after that means you accept the new version.
      </p>

      <h2>14. Contact</h2>
      <p>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. A real person reads it.
      </p>
    </>
  )
}
