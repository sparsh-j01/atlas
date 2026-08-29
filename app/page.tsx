import Link from 'next/link'

const questions = [
  { letter: "A", text: "Connect devices", percent: 34 },
  { letter: "B", text: "Deliver packets", percent: 72 },
  { letter: "C", text: "Encrypt traffic", percent: 21 },
  { letter: "D", text: "Translate domains", percent: 48 },
];

export default function Home() {
  return (
    <main className="atlas-page">

      {/* NAVIGATION */}
      <nav className="navbar">
        <div className="logo">
          ATLAS <span>✦</span>
        </div>

        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#classroom">Classroom</a>
          <a href="#teachers">For teachers</a>
          <a href="#pricing">Pricing</a>
          <a href="#resources">Resources⌄</a>
        </div>

        <div className="nav-actions">
          <Link href="/login" className="login-link">
            Log in
          </Link>

          <Link href="/login" className="nav-button">
            Get started →
          </Link>
        </div>
      </nav>


      {/* HERO */}
      <section className="hero">

        <div className="hero-left">

          <div className="eyebrow">
            <span>●</span> LIVE LEARNING PLATFORM
          </div>

          <div className="hero-title">
            <div>Turn your</div>
            <div>lectures into</div>
            <div className="blue-text">live games.</div>
          </div>

          <div className="blue-scribble">
            ─────────╮
          </div>

          <div className="sticky-note">
            <strong>Your material.</strong>
            <br />
            Your questions.
            <br />
            Your classroom.
            <br />
            <u>Live.</u>
          </div>

          <p className="hero-description">
            Upload your content. Atlas creates interactive
            questions your whole class can play together,
            in real time.
          </p>

          <div className="hero-buttons">
            <Link href="/login" className="primary-button">
              Create a classroom →
            </Link>

            <Link href="/play" className="secondary-button">
              Join with code
            </Link>
          </div>

          <div className="teacher-proof">
            <div className="avatars">
              <span>👩🏻</span>
              <span>👨🏽</span>
              <span>👩🏼</span>
            </div>

            <div>
              <strong>Loved by 10,000+ teachers</strong>
              <br />
              <span>and growing!</span>
            </div>
          </div>

        </div>


        {/* QUIZ MOCKUP */}
        <div className="hero-right">

          <div className="live-label">
            ✦ LIVE CLASSROOM
          </div>

          <div className="quiz-window">

            <div className="window-top">
              <div className="window-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>

              <div className="live-pill">
                ● LIVE
              </div>
            </div>

            <div className="quiz-content">

              <div className="question-meta">
                QUESTION 04 / 10
                <span>00:14</span>
              </div>

              <h2>
                What is the primary
                purpose of TCP?
              </h2>

              <div className="answers">
                {questions.map((question) => (
                  <div
                    className={`answer ${
                      question.letter === "B" ? "answer-active" : ""
                    }`}
                    key={question.letter}
                  >
                    <div className="answer-letter">
                      {question.letter}
                    </div>

                    <div className="answer-text">
                      {question.text}
                    </div>

                    <div
                      className="answer-fill"
                      style={{
                        width: `${question.percent}%`,
                      }}
                    />

                    <div className="answer-percent">
                      {question.percent}%
                    </div>
                  </div>
                ))}
              </div>

              <div className="quiz-footer">
                <span>142 STUDENTS ANSWERING</span>
                <strong>● LIVE</strong>
              </div>

            </div>
          </div>


          <div className="student-note">
            <small>STUDENTS ONLINE</small>
            <strong>142</strong>
          </div>

          <div className="arrow-doodle">
            ↝
          </div>

        </div>
      </section>


      {/* BLUE PROCESS STRIP */}
      <section className="process-strip">

        <div>UPLOAD</div>
        <span>✦</span>

        <div>GENERATE</div>
        <span>✦</span>

        <div>REVIEW</div>
        <span>✦</span>

        <div>PLAY</div>
        <span>✦</span>

        <div>LEARN</div>

      </section>


      {/* HOW IT WORKS */}
      <section
        className="how-section"
        id="how-it-works"
      >

        <div className="how-heading">

          <div className="section-label">
            HOW IT WORKS
          </div>

          <h2>
            From lecture
            <br />
            material to a
            <br />
            room full of
            <br />
            answers.
          </h2>

        </div>


        <div className="steps">

          <div className="step">
            <div className="step-number">01</div>

            <div className="step-icon">
              📄
            </div>

            <div>
              <h3>Bring your material</h3>
              <p>
                Upload a lecture, notes,
                or teaching material.
              </p>
            </div>
          </div>


          <div className="step-arrow">
            →
          </div>


          <div className="step">
            <div className="step-number">02</div>

            <div className="step-icon">
              🪄
            </div>

            <div>
              <h3>Atlas builds the game</h3>
              <p>
                We generate questions
                grounded in your content.
              </p>
            </div>
          </div>


          <div className="step-arrow">
            →
          </div>


          <div className="step">
            <div className="step-number">03</div>

            <div className="step-icon">
              👥
            </div>

            <div>
              <h3>Play it live</h3>
              <p>
                Students join with a code
                and your classroom comes alive.
              </p>
            </div>
          </div>

        </div>

        <div className="simple-doodle">
          It&apos;s that
          <br />
          simple!
          ↘
        </div>

      </section>


      {/* DARK CLASSROOM SECTION */}
      <section
        className="classroom-section"
        id="classroom"
      >

        <div className="classroom-intro">

          <div className="lime-label">
            BUILT FOR THE ROOM
          </div>

          <h2>
            One screen for you.
            <br />
            A great experience
            <br />
            for every student.
          </h2>

          <p>
            Keep your class engaged with live polls,
            leaderboards, and instant feedback while
            Atlas keeps everyone in sync.
          </p>

          <Link href="/host/demo" className="lime-link">
            See it in action →
          </Link>

          <div className="star-doodle">
            ☆
          </div>

        </div>


        <div className="classroom-demo">

          <div className="demo-header">
            <div>
              <small>ROOM CODE</small>
              <strong>ATLAS-8421</strong>
            </div>

            <div className="students-count">
              23 / 30
              <small>students</small>
            </div>
          </div>

          <div className="demo-question">
            Which layer of the TCP/IP model
            handles routing?
          </div>

          <div className="demo-options">

            <div>
              <span>01</span>
              Application
            </div>

            <div>
              <span>02</span>
              Transport
            </div>

            <div className="selected-option">
              <span>03</span>
              Internet
            </div>

            <div>
              <span>04</span>
              Network Access
            </div>

          </div>

        </div>


        <div className="classroom-stats">

          <div>
            <strong>87%</strong>
            <span>class accuracy</span>
          </div>

          <div>
            <strong>2m 14s</strong>
            <span>average time</span>
          </div>

          <div>
            <strong>7</strong>
            <span>questions left</span>
          </div>

        </div>

      </section>


      {/* FINAL CTA */}
      <section className="final-section">

        <div className="rocket">
          🚀
        </div>

        <div className="heart">
          ♡
          <br />
          ♡
        </div>

        <div className="final-label">
          READY WHEN YOU ARE
        </div>

        <h2>
          Make your next
          <br />
          lecture{" "}
          <span>playable.</span>
        </h2>

        <p>
          It takes less than a minute!
        </p>

        <Link href="/login" className="primary-button">
          Create your first classroom →
        </Link>

      </section>


      {/* FOOTER */}
      <footer className="footer">

        <div className="footer-logo">
          ATLAS <span>✦</span>
        </div>

        <div>
          Interactive learning, built for the classroom.
        </div>

        <div>
          © 2026 Atlas, Inc.
        </div>

      </footer>

    </main>
  );
}