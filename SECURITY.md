# Security

These guards catch mistakes made by agents acting in good faith. They read a command before it runs, and a shell can do more than any reader can see, so they aren't a sandbox and they won't stop a determined attacker. For that, run agents in a container with limited credentials, and keep the guards on as well.

## Reporting a problem

If you find a way past a guard, or a way a hook could expose a credential, please report it privately. Open the Security tab of this repository and choose "Report a vulnerability".
