//! `ghosteranti-mcp` starts the MCP helper that ships inside the `ghosteranti-sidecar` program.
//!
//! AI clients and Remote MCP start this file by its installed path. It keeps that path and passes
//! the arguments, the environment, stdin, stdout, stderr and the exit code through unchanged.

use std::{
    env,
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

/// First argument that makes the sidecar program run the MCP helper. Keep in step with sidecar-entry.ts.
const MCP_MODE: &str = "__mcp";

fn sidecar_command(launcher: &Path, args: impl IntoIterator<Item = OsString>) -> Option<Command> {
    let sidecar = launcher.parent()?.join(if cfg!(windows) {
        "ghosteranti-sidecar.exe"
    } else {
        "ghosteranti-sidecar"
    });
    let mut command = Command::new(sidecar);
    command.arg(MCP_MODE).args(args);
    Some(command)
}

fn launcher_path() -> std::io::Result<PathBuf> {
    let path = env::current_exe()?;
    // macOS reports the path of a symlink; the sidecar is next to the real file.
    #[cfg(unix)]
    let path = std::fs::canonicalize(path)?;
    Ok(path)
}

fn fail(message: &str) -> ! {
    // stderr may be closed; the exit code still reports the failure.
    let _ = writeln!(std::io::stderr(), "[ghosteranti-mcp] {message}");
    std::process::exit(1);
}

fn main() {
    let command = launcher_path()
        .ok()
        .and_then(|launcher| sidecar_command(&launcher, env::args_os().skip(1)));
    let Some(command) = command else {
        fail("the GhosterAnti installation folder is unavailable");
    };
    let error = run(command);
    fail(&format!("the GhosterAnti program could not start: {error}"));
}

/// Replaces this process, so the process id, signals and stdio of the client reach the helper.
#[cfg(unix)]
fn run(mut command: Command) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    command.exec()
}

/// Windows has no exec: run the helper as a child with the same stdio and exit with its code.
#[cfg(windows)]
fn run(mut command: Command) -> std::io::Error {
    use std::os::windows::{io::AsRawHandle, process::CommandExt};
    use windows::Win32::{
        Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT},
        System::{
            Console::{
                GetConsoleWindow, GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
                STD_OUTPUT_HANDLE,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            },
            Threading::CREATE_NO_WINDOW,
        },
    };

    // The helper gets its own copies of stdin, stdout and stderr. The client's handles in this
    // process must not reach it as extra inherited handles: the helper clears inheritance on its
    // stdio only, so a program that it starts, such as GhosterAnti, would keep the client's pipes
    // open and the client would never see the end of the output.
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        if let Ok(handle) = unsafe { GetStdHandle(id) } {
            if !handle.is_invalid() {
                let _ =
                    unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) };
            }
        }
    }
    // A client that starts this helper without a console must not get a console window for it.
    if unsafe { GetConsoleWindow() }.is_invalid() {
        command.creation_flags(CREATE_NO_WINDOW.0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return error,
    };
    // A client that ends this process also ends the helper, as when the helper was this process.
    // The helper's own children (the Node host and the desktop app) stay outside this job.
    unsafe {
        if let Ok(job) = CreateJobObjectW(None, None) {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_ok()
            {
                let _ = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle()));
            }
        }
    }
    match child.wait() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_the_sidecar_next_to_the_launcher_in_mcp_mode() {
        let launcher = Path::new("install").join(if cfg!(windows) {
            "ghosteranti-mcp.exe"
        } else {
            "ghosteranti-mcp"
        });
        let command = sidecar_command(
            &launcher,
            ["setup", "--client", "auto", "--yes"].map(OsString::from),
        )
        .expect("launcher folder");
        let expected = Path::new("install").join(if cfg!(windows) {
            "ghosteranti-sidecar.exe"
        } else {
            "ghosteranti-sidecar"
        });
        assert_eq!(command.get_program(), expected.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["__mcp", "setup", "--client", "auto", "--yes"]
        );
        // The environment is inherited as it is.
        assert_eq!(command.get_envs().count(), 0);
    }
}
