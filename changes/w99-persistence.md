- **A failed paid call changes the run's strategy; it never ends the run (SRI-203).** Run adf318ab asked
  for an erotic story and pictures; two image services refused the pictures with HTTP 400 and the
  three-failures breaker ended the run before the story, which needed no service, was written. The
  owner read "User stopped".
  - No stop on failure counts. The 3-service-failures breaker and the "failed repeatedly" stop are gone
    (`persistence.ts`).
  - An exact repeat of a failed paid call is refused unsent. A failed, uninspected endpoint must be
    inspected before it is called again. An endpoint that failed three times is marked bad for the
    rest of the run.
  - Every failed paid call carries a strategy: read the seller's answer, fix the request or switch
    provider, and deliver what does not need it.
  - Four turns in a row with nothing working bring a change-of-strategy message. After twelve,
    CrowdCode asks for the deliverable and ends the run. The last of a run's turns, at its turn limit,
    also delivers. The answer comes first, then `Stopped by CrowdCode: <reason>`.
  - An empty reply is asked about once, instead of failing the run. An answer cut off by the output
    limit is continued three times, not once.
- **The seller's reason is in the error line.** "the service answered HTTP 400: The model's content
  check refused this prompt… Flagged: sexual" (`sellerSays`), truncated and scrubbed.
- **New run outcome `stopped`**: CrowdCode ended the run, never the owner. The worker used to report
  every runtime stop as `user_stopped`. `CROWDCODE_STOP` and `splitCrowdcodeStop` are in
  `@opencrowd/protocol`.
