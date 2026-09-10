import Link from 'next/link'
import { CONTACT_EMAIL, ENTITY, GRIEVANCE_OFFICER, POSTAL_ADDRESS, SITE_URL } from '../legal-info'

export const metadata = {
  title: 'Privacy Policy',
  description: 'What Atlas collects, who else sees it, and how to get it removed.',
}

export default function Privacy() {
  return (
    <>
      <h1 className="font-display text-[44px] leading-none text-ink">Privacy Policy</h1>

      <div className="mt-8 rounded-plate border border-rule bg-raised p-6">
        <p className="mt-0 font-semibold text-ink">The short version</p>
        <ul>
          <li>Two kinds of people use Atlas: teachers, who have accounts, and students, who do not.</li>
          <li>
            A student gives a nickname. We never ask a student for a name, email, phone number,
            age, or location.
          </li>
          <li>We sell nothing, advertise nothing, and run no analytics or tracking cookies.</li>
          <li>
            Text from a document a teacher uploads is sent to Google’s Gemini API to write
            questions from it. Read section 4 before you upload anything.
          </li>
          <li>
            For what happens in a live class, the school or teacher decides and we act on their
            instruction.
          </li>
        </ul>
      </div>

      <h2>1. Who we are</h2>
      <p>
        Atlas is operated by {ENTITY}, {POSTAL_ADDRESS}, at{' '}
        {SITE_URL}. You can reach us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> about anything on this page.
      </p>
      <p>
        Under India’s Digital Personal Data Protection Act, 2023 (the <strong>DPDP Act</strong>)
        we play two different roles, and it matters which one applies:
      </p>
      <ul>
        <li>
          <strong>For a teacher’s own account</strong> — the email address, the decks, the
          uploaded files — we are the <strong>Data Fiduciary</strong>. We decide why that data is
          processed, and this policy is our notice to you.
        </li>
        <li>
          <strong>For what a class produces in a live session</strong> — nicknames, answers,
          scores — the school or the teacher is the Data Fiduciary. We are a{' '}
          <strong>Data Processor</strong> acting on their instruction. We do not use that data for
          our own purposes.
        </li>
      </ul>

      <h2>2. What we collect</h2>

      <h3>From teachers</h3>
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th>Where it comes from</th>
            <th>Why we have it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Email address</td>
            <td>You at sign-up, or your Google account</td>
            <td>Identifies your account, signs you in, sends password resets</td>
          </tr>
          <tr>
            <td>Display name</td>
            <td>You, or your Google profile</td>
            <td>Shown on your own dashboard</td>
          </tr>
          <tr>
            <td>Password</td>
            <td>You</td>
            <td>
              Held only as a hash by Supabase Auth. Nobody at Atlas can read it, and it is never
              written to a log
            </td>
          </tr>
          <tr>
            <td>Google account identifier</td>
            <td>Google, only if you use Sign in with Google</td>
            <td>Links that sign-in to your account</td>
          </tr>
          <tr>
            <td>Decks, slides, questions</td>
            <td>You, or AI generation you started</td>
            <td>This is the product</td>
          </tr>
          <tr>
            <td>PDF and PowerPoint files you upload</td>
            <td>You</td>
            <td>To write questions grounded in your own material</td>
          </tr>
          <tr>
            <td>Session records</td>
            <td>Created as you host a class</td>
            <td>So you can reopen and export past results</td>
          </tr>
        </tbody>
      </table>
      <p>
        We do not ask a teacher for a phone number, date of birth, postal address, or payment
        details.
      </p>

      <h3>From students</h3>
      <p>
        A student never signs up, never gives an email address, and never sets a password. They
        type a six-digit code and a nickname. That is the whole of it:
      </p>
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th>Where it comes from</th>
            <th>Why we have it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Nickname</td>
            <td>Typed by the student</td>
            <td>Identifies them on the leaderboard and to their teacher</td>
          </tr>
          <tr>
            <td>Avatar</td>
            <td>Drawn from the nickname</td>
            <td>
              A cartoon generated from the letters of the nickname. No photo is uploaded or asked
              for
            </td>
          </tr>
          <tr>
            <td>Answers, score, streak, response time</td>
            <td>Their taps during the class</td>
            <td>To score the quiz and rank the leaderboard</td>
          </tr>
          <tr>
            <td>A session token</td>
            <td>Issued by our server when they join</td>
            <td>So a phone that reloads mid-quiz gets its own seat back, not someone else’s</td>
          </tr>
        </tbody>
      </table>
      <p>
        A nickname becomes personal data the moment a student types their real name into it. If
        you would rather real names were not on the projector, tell your class to pick a nickname
        before you start.
      </p>
      <p>
        We collect no email address, phone number, age, date of birth, location, IP-based
        profile, or advertising identifier from students. A participant record belongs to exactly
        one session and is not linked to any other. There is no such thing as a student profile
        in Atlas, in this session or across them.
      </p>

      <h2>3. What we never do</h2>
      <ul>
        <li>No advertising, no ad networks, no ad identifiers.</li>
        <li>No profiling and no behavioural monitoring, of students or of anyone.</li>
        <li>No selling, renting, or sharing personal data for anyone else’s marketing.</li>
        <li>No analytics, heatmap, or session-replay tooling.</li>
        <li>
          No cookie banner, because there is nothing to consent to: the only cookies we set are
          the ones that make signing in work. Section 7 lists them by name.
        </li>
      </ul>

      <h2>4. Uploaded documents and the AI</h2>
      <p>Read this before you upload anything.</p>
      <p>
        Atlas can write a deck from a topic you type, or from a lecture PDF or PowerPoint file you
        upload. Both paths send text to <strong>Google’s Gemini API</strong>, which processes it
        outside India.
      </p>
      <ul>
        <li>
          <strong>From a topic:</strong> only the prompt you typed is sent.
        </li>
        <li>
          <strong>From a document:</strong> we extract the text, split it into passages, and send
          those passages to Google — both to compute embeddings for retrieval and to write the
          questions. Images inside the file are not sent for recognition; we do not run OCR.
        </li>
      </ul>
      <p>
        The file itself is stored in Supabase Storage. The extracted text, the passages, and their
        embeddings are stored in our database, so a question can show you the passage it came
        from.
      </p>
      <p>
        <strong>
          Atlas currently runs on the free tier of the Gemini API, and Google may use content sent
          on that tier to improve its models.
        </strong>{' '}
        Do not upload confidential, exam-secure, or personal material — a class list, marked
        scripts, medical or disciplinary notes. Lecture slides and teaching notes are what this is
        built for. Google’s handling of what it receives is governed by its own terms, not by
        this policy.
      </p>
      <p>
        Questions written by the AI can be wrong. Review a generated deck before you teach from
        it. That is a term of service as well as a warning.
      </p>

      <h2>5. Who else handles the data</h2>
      <p>We use these services and no others. None of them is paid to receive your data.</p>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>What it handles</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Supabase</td>
            <td>The database, sign-in, and file storage. Everything above lives here first</td>
            <td>Mumbai, India</td>
          </tr>
          <tr>
            <td>Google — Gemini API</td>
            <td>Topic prompts, extracted document text, generated questions</td>
            <td>Outside India</td>
          </tr>
          <tr>
            <td>Google — Sign in with Google</td>
            <td>Your email and profile name, only if you choose that sign-in</td>
            <td>Outside India</td>
          </tr>
          <tr>
            <td>DiceBear</td>
            <td>
              The student’s <strong>nickname</strong>, to draw the avatar. The request is made by
              the student’s own browser, so their IP address is visible to DiceBear too
            </td>
            <td>Outside India</td>
          </tr>
          <tr>
            <td>Vercel</td>
            <td>Hosting. Page requests and short-lived server logs</td>
            <td>Outside India</td>
          </tr>
        </tbody>
      </table>
      <p>
        Section 16 of the DPDP Act permits transferring personal data outside India except to
        countries the Central Government restricts. None of the above is in a restricted country
        today. If that changes, we will change the service rather than the policy.
      </p>

      <h2>6. Children, schools, and consent</h2>
      <p>
        Under the DPDP Act a <strong>child</strong> is anyone under 18. Section 9 requires
        verifiable consent from a parent or guardian before a child’s data is processed, and flatly
        prohibits tracking, behavioural monitoring, and advertising directed at children.
      </p>
      <p>Atlas is built for a classroom, so students in a room are often children.</p>
      <ul>
        <li>
          We do no tracking, no behavioural monitoring, and no advertising of any kind — for
          children or for anyone else. Section 3 is not marketing copy; it is how the product is
          built.
        </li>
        <li>
          Atlas is supplied to a school or a teacher, not to students directly. A student joins a
          room their teacher opened, in a class their teacher runs, on their teacher’s
          instruction.
        </li>
        <li>
          The school or teacher is responsible for the lawful basis of that class, including any
          parental consent it needs. The Fourth Schedule to the DPDP Rules, 2025 exempts an
          educational institution from parts of section 9 to the extent necessary for providing
          education — whether that applies is the school’s call, not ours.
        </li>
        <li>
          We process what the class produces only to run the class and show the teacher the
          results. We do not use it to build anything, train anything, or contact anyone.
        </li>
      </ul>
      <p>
        Because we never ask for an age, we cannot tell whether a nickname belongs to a child. If a
        parent, guardian, or school tells us a particular participant record should be removed,
        we remove it. Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the
        session code and the nickname.
      </p>
      <p>
        A teacher account is for an adult. See the{' '}
        <Link href="/legal/terms">Terms of Service</Link>.
      </p>

      <h2>7. Cookies and local storage</h2>
      <p>
        There are no tracking, advertising, or analytics cookies on this site. This is the complete
        list of what we store on your device:
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>What it is</th>
            <th>How long</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>sb-…-auth-token</code>
            </td>
            <td>
              Your signed-in session, set by Supabase Auth. Marked httpOnly, so no script on the
              page can read it
            </td>
            <td>Until you sign out or it expires</td>
          </tr>
          <tr>
            <td>
              <code>htk_&lt;code&gt;</code>
            </td>
            <td>
              Proves this browser is the host of the live session with that code, so only you can
              advance your own slides
            </td>
            <td>6 hours</td>
          </tr>
          <tr>
            <td>
              <code>quiz:session</code>
            </td>
            <td>
              Local storage, not a cookie. A student’s seat in the room they are currently in, so
              a reload rejoins instead of starting over
            </td>
            <td>Until the class ends or the browser data is cleared</td>
          </tr>
        </tbody>
      </table>
      <p>
        All three are strictly necessary. Clearing them signs you out, or loses a student’s place
        in the room. Nothing else is stored.
      </p>

      <h2>8. How long we keep it</h2>
      <ul>
        <li>
          <strong>Your account and decks</strong> — for as long as the account exists.
        </li>
        <li>
          <strong>Uploaded files and their extracted text</strong> — until you delete the
          document, or the account.
        </li>
        <li>
          <strong>Session records</strong> — nicknames, answers, and scores are kept so you can
          reopen and export past results.
        </li>
      </ul>
      <p>
        Two honest caveats. <strong>Deleting a deck does not delete the classes you ran from it</strong>
        — the session record survives with the deck reference removed, so the results page keeps
        working. And we do not currently run an automatic deletion clock over old sessions. If you
        want a class’s results gone, ask and we will remove them.
      </p>
      <p>
        There is <strong>no self-service account deletion in the app yet</strong>. Email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address on the account and
        we will delete the account and everything attached to it — decks, uploaded files, sessions,
        participants, and answers — within 30 days.
      </p>

      <h2>9. Your rights</h2>
      <p>Under the DPDP Act you can ask us to:</p>
      <ul>
        <li>tell you what personal data of yours we hold and who we have shared it with;</li>
        <li>correct, complete, or update anything inaccurate;</li>
        <li>erase it, where we are not required to keep it;</li>
        <li>nominate someone to exercise these rights if you die or become incapacitated.</li>
      </ul>
      <p>
        Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from the address on your
        account. There is no charge. We answer within 30 days, and we complete grievance redressal
        within the 90 days the DPDP Rules allow.
      </p>
      <p>
        <strong>Withdrawing consent is as easy as giving it.</strong> A teacher withdraws by
        asking us to delete the account, in one email. A student withdraws by leaving the room; a
        teacher can also remove someone from the roster mid-class, and either of you can ask us to
        delete the record afterwards.
      </p>
      <p>
        For student data, the school or teacher decides — so a request from a student or parent
        goes to them first. Send it to us and we will act on it as the school instructs, or pass
        it on if we cannot identify who to ask.
      </p>

      <h2>10. Complaints</h2>
      <p>
        Our Grievance Officer is {GRIEVANCE_OFFICER}, reachable at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Say what happened and what you
        want done.
      </p>
      <p>
        If we do not resolve it, you can complain to the{' '}
        <strong>Data Protection Board of India</strong> under section 13 of the DPDP Act. You do
        not need our permission to do that.
      </p>

      <h2>11. Security</h2>
      <p>What is actually in place, not what we aspire to:</p>
      <ul>
        <li>
          Row-level security is on for every table. A student’s browser holds no database
          credentials and cannot read or write any table directly — every action goes through a
          server endpoint that checks it first.
        </li>
        <li>Session cookies are httpOnly, so a script on the page cannot steal one.</li>
        <li>
          Scoring happens on the server, against the server’s clock. The correct answer is never
          sent to a student’s phone before the reveal.
        </li>
        <li>
          Uploads are checked for file type, declared size, real size, magic bytes, and page count
          before anything is stored.
        </li>
        <li>The site is HTTPS only, with HSTS, and a Content Security Policy on every page.</li>
      </ul>
      <p>
        No system is perfectly secure. If a breach affects your data we will tell you and the Data
        Protection Board, as the DPDP Act requires. If you find a security problem, email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will credit you if you would
        like.
      </p>

      <h2>12. Changes</h2>
      <p>
        We will update the date at the bottom of this page whenever it changes. For anything that
        materially changes what we collect or who we send it to, we will email account holders
        before it takes effect.
      </p>
    </>
  )
}
