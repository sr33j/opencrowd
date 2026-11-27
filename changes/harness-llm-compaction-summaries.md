- **Compaction keeps a summary the model writes, not a line per message.**
  After a compaction the agent kept "ran: run_shell" and file pointers, and on
  long tasks forgot what it had found: in an A/B on a log-reading task, recall
  after compaction went from 58% to 100% and runs stopped hitting the turn
  limit. The model now writes the summary once per compaction from the history
  it has just cached: goals, decisions, facts, files, money and open threads.
  - About $0.0009 a compaction on GPT-6 Luna (95% of its input cached), and 9 s.
  - A hosted summary is the turn's own operation (`<run>:llm:<n>:summary`); pauses and budget stops travel, and a resume replays it.
  - Any other failure keeps the one-line digest; a summary never fails a turn.
