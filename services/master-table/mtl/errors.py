class MtlError(Exception):
    """A stable machine-readable refusal."""

    def __init__(self, code, exit_code=1):
        self.code = str(code)
        self.exit_code = int(exit_code)
        super().__init__(self.code)
