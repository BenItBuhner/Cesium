export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 502 = 400,
    readonly code = "project_error"
  ) {
    super(message);
    this.name = "ProjectError";
  }
}
