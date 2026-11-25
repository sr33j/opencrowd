- **`read_file` with a `scope` reads a file instead of listing it as a folder.**
  Hosted runs that passed `scope` alongside a file's path got `ENOTDIR:
  not a directory, scandir …` on every retry until the run was stopped
  (SRI-213). A scope still lists a folder, or every chat's files when the path
  is not a file in this chat.
