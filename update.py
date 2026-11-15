"""Updates Seller Toolkit to the latest version from GitHub.

Replaces the program files only. Your data (data.db) and any built website
(storefront_build) are never touched. Uses only the Python standard library.
"""
import io
import json
import os
import sys
import urllib.request
import zipfile

REPO = "TruesdaleGit/AMZ"
BRANCH = "main"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION_FILE = os.path.join(APP_DIR, ".installed_version")
KEEP = {"data.db", "storefront_build", ".installed_version"}  # never overwritten


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "seller-toolkit-updater"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def latest_commit():
    """(sha, date, message) of the newest version, or None if GitHub cannot say."""
    try:
        data = json.loads(fetch(f"https://api.github.com/repos/{REPO}/commits/{BRANCH}"))
        return data["sha"], data["commit"]["committer"]["date"][:10], data["commit"]["message"].splitlines()[0]
    except Exception:
        return None


def install(archive_bytes):
    """Copy every file from the downloaded archive over the app folder."""
    written = 0
    root = os.path.realpath(APP_DIR)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        for info in archive.infolist():
            # GitHub wraps everything in one top-level folder, e.g. "AMZ-main/".
            relative = info.filename.split("/", 1)[1] if "/" in info.filename else ""
            if not relative or info.is_dir() or relative.split("/")[0] in KEEP:
                continue
            target = os.path.realpath(os.path.join(root, *relative.split("/")))
            if not target.startswith(root + os.sep):
                continue  # refuse anything that would land outside the app folder
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target + ".new", "wb") as out:
                out.write(archive.read(info))
            os.replace(target + ".new", target)
            written += 1
    return written


def main():
    print("Checking for updates...")
    installed = open(VERSION_FILE).read().strip() if os.path.isfile(VERSION_FILE) else ""
    latest = latest_commit()
    if latest and latest[0] == installed:
        print("Seller Toolkit is already up to date.")
        return 0
    print("Downloading the latest version...")
    try:
        archive = fetch(f"https://github.com/{REPO}/archive/refs/heads/{BRANCH}.zip")
    except Exception as error:
        print(f"Could not download the update: {error}")
        print("Check your internet connection and try again. Nothing was changed.")
        return 1
    try:
        count = install(archive)
    except Exception as error:
        print(f"The update failed part-way: {error}")
        print("Your data is safe. Run the update again to finish it.")
        return 1
    if latest:
        with open(VERSION_FILE, "w") as f:
            f.write(latest[0])
        print(f"Updated {count} files to the version from {latest[1]}: {latest[2]}")
    else:
        print(f"Updated {count} files.")
    print("If Seller Toolkit is open, close its window and start it again to use the new version.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
