using System;
using System.Drawing;
using System.Windows.Forms;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using System.Collections.Generic;

namespace GeminiProxyLauncher
{
    public class LauncherApp : ApplicationContext
    {
        public const string Version = "0.1.2";
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        private NotifyIcon trayIcon;
        private ContextMenuStrip contextMenu;
        private ToolStripMenuItem statusItem;
        private ToolStripMenuItem startServerItem;
        private ToolStripMenuItem stopServerItem;
        private ToolStripMenuItem restartServerItem;
        private ToolStripMenuItem openBrowserItem;
        private ToolStripMenuItem startWithWindowsItem;
        private ToolStripMenuItem startMinimizedItem;
        private ToolStripMenuItem exitItem;

        private Timer pollTimer;
        private bool isServerRunning = false;
        private bool isStarting = false;
        private string lastStatus = "unknown";
        private Icon mainIcon;
        private Icon greenIcon;
        private Icon redIcon;
        private Icon orangeIcon;
        private Icon blackIcon;

        private string appDataPath;
        private string settingsFile;
        private string projectRoot = null;
        private const int Port = 8765;
        private const string RegistryKeyName = "gemini-proxy-launcher";

        public LauncherApp(string[] args)
        {
            appDataPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "gemini-proxy");
            if (!Directory.Exists(appDataPath)) Directory.CreateDirectory(appDataPath);
            settingsFile = Path.Combine(appDataPath, "launcher.json");

            projectRoot = ResolveProjectRoot();

            bool startMinimizedOnLaunch = Array.Exists(args, arg => arg.Equals("--minimized", StringComparison.OrdinalIgnoreCase));

            InitializeIcons();
            InitializeContextMenu();

            trayIcon = new NotifyIcon()
            {
                Icon = mainIcon ?? redIcon,
                ContextMenuStrip = contextMenu,
                Visible = true,
                Text = "gemini-proxy - Initializing..."
            };

            pollTimer = new Timer();
            pollTimer.Interval = 2000;
            pollTimer.Tick += (s, e) => PollStatus();
            pollTimer.Start();

            if (!string.IsNullOrEmpty(projectRoot) && (File.Exists(Path.Combine(projectRoot, "src", "server.ts")) || File.Exists(Path.Combine(projectRoot, "server.ts"))))
            {
                StartServer();
            }

            PollStatus();
        }

        private string ResolveProjectRoot()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

            // 1. Check if server.ts or src/server.ts exists in exeDir or parent dirs
            string current = exeDir;
            for (int i = 0; i < 4; i++)
            {
                if (File.Exists(Path.Combine(current, "src", "server.ts")) || File.Exists(Path.Combine(current, "server.ts")))
                {
                    return current;
                }
                DirectoryInfo parent = Directory.GetParent(current);
                if (parent == null) break;
                current = parent.FullName;
            }

            // 2. Check settingsFile in AppData for saved projectRoot
            if (File.Exists(settingsFile))
            {
                try
                {
                    string content = File.ReadAllText(settingsFile);
                    int idx = content.IndexOf("\"projectRoot\"");
                    if (idx != -1)
                    {
                        int startQuote = content.IndexOf('"', idx + 13);
                        if (startQuote != -1)
                        {
                            int endQuote = content.IndexOf('"', startQuote + 1);
                            if (endQuote != -1)
                            {
                                string savedPath = content.Substring(startQuote + 1, endQuote - startQuote + 1 - 2);
                                savedPath = savedPath.Replace("\\\\", "\\");
                                if (Directory.Exists(savedPath) && (File.Exists(Path.Combine(savedPath, "src", "server.ts")) || File.Exists(Path.Combine(savedPath, "server.ts"))))
                                {
                                    return savedPath;
                                }
                            }
                        }
                    }
                }
                catch { }
            }

            // 3. Fallback to exeDir and prompt user if needed
            return exeDir;
        }

        private void SaveProjectRoot(string path)
        {
            try
            {
                bool startMin = IsStartMinimized();
                string json = string.Format("{{\n  \"startMinimized\": {0},\n  \"projectRoot\": \"{1}\"\n}}", startMin.ToString().ToLower(), path.Replace("\\", "\\\\"));
                File.WriteAllText(settingsFile, json);
            }
            catch { }
        }

        private void InitializeIcons()
        {
            try
            {
                mainIcon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName);
            }
            catch
            {
                mainIcon = null;
            }

            greenIcon = CreateCircleIcon(Color.FromArgb(46, 204, 113));  // Emerald Green (#2ecc71)
            redIcon = CreateCircleIcon(Color.FromArgb(231, 76, 60));    // Alizarin Red (#e74c3c)
            orangeIcon = CreateCircleIcon(Color.FromArgb(243, 156, 18)); // Orange (#f39c12)
            blackIcon = CreateCircleIcon(Color.FromArgb(50, 50, 50));    // Dark Gray/Black (#323232)
        }

        private Icon CreateCircleIcon(Color color)
        {
            using (Bitmap bmp = new Bitmap(32, 32))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (Brush b = new SolidBrush(color))
                    {
                        g.FillEllipse(b, 2, 2, 28, 28);
                    }
                    using (Pen p = new Pen(Color.FromArgb(60, Color.Black), 2))
                    {
                        g.DrawEllipse(p, 2, 2, 28, 28);
                    }
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        private void InitializeContextMenu()
        {
            contextMenu = new ContextMenuStrip();

            statusItem = new ToolStripMenuItem("gemini-proxy v" + Version + " - Stopped");
            statusItem.Enabled = false;
            statusItem.Font = new Font(statusItem.Font, FontStyle.Bold);

            startServerItem = new ToolStripMenuItem("Start Server", null, (s, e) => StartServer());
            stopServerItem = new ToolStripMenuItem("Stop Server", null, (s, e) => StopServer());
            restartServerItem = new ToolStripMenuItem("Restart Server", null, (s, e) => RestartServer());
            openBrowserItem = new ToolStripMenuItem("Open in Browser", null, (s, e) => OpenInBrowser());
            ToolStripMenuItem openTerminalItem = new ToolStripMenuItem("Open Terminal", null, (s, e) => OpenTerminal());

            ToolStripMenuItem locateFolderItem = new ToolStripMenuItem("Locate Project Folder...", null, (s, e) => LocateProjectFolder());

            ToolStripSeparator sep1 = new ToolStripSeparator();

            startWithWindowsItem = new ToolStripMenuItem("Start with Windows", null, (s, e) => ToggleStartWithWindows());
            startWithWindowsItem.Checked = IsRegisteredForStartup();

            startMinimizedItem = new ToolStripMenuItem("Start Minimized to System Tray", null, (s, e) => ToggleStartMinimized());
            startMinimizedItem.Checked = IsStartMinimized();

            ToolStripSeparator sep2 = new ToolStripSeparator();

            exitItem = new ToolStripMenuItem("Exit", null, (s, e) => Exit());

            contextMenu.Items.AddRange(new ToolStripItem[] {
                statusItem,
                new ToolStripSeparator(),
                startServerItem,
                stopServerItem,
                restartServerItem,
                openBrowserItem,
                openTerminalItem,
                locateFolderItem,
                sep1,
                startWithWindowsItem,
                startMinimizedItem,
                sep2,
                exitItem
            });
        }

        private void LocateProjectFolder()
        {
            using (FolderBrowserDialog fbd = new FolderBrowserDialog())
            {
                fbd.Description = "Select the gemini-proxy project folder containing src/server.ts";
                if (!string.IsNullOrEmpty(projectRoot) && Directory.Exists(projectRoot))
                {
                    fbd.SelectedPath = projectRoot;
                }
                if (fbd.ShowDialog() == DialogResult.OK)
                {
                    string selected = fbd.SelectedPath;
                    if (File.Exists(Path.Combine(selected, "src", "server.ts")) || File.Exists(Path.Combine(selected, "server.ts")))
                    {
                        projectRoot = selected;
                        SaveProjectRoot(projectRoot);
                        MessageBox.Show("Project folder set successfully to:\n" + projectRoot, "Success", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    else
                    {
                        MessageBox.Show("The selected folder does not contain 'src/server.ts' or 'server.ts'. Please select a valid gemini-proxy directory.", "Invalid Folder", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
            }
        }

        private void OpenTerminal()
        {
            try
            {
                if (string.IsNullOrEmpty(projectRoot)) return;
                Process.Start("cmd.exe", string.Format("/c start cmd.exe /k \"cd /d {0} && bun run src/server.ts\"", projectRoot));
            }
            catch { }
        }

        private void PollStatus()
        {
            bool portOpen = IsPortInUse(Port);
            string status = "unknown";

            if (portOpen)
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(string.Format("http://127.0.0.1:{0}/health", Port));
                    request.Timeout = 500;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                        {
                            string json = reader.ReadToEnd();
                            if (json.Contains("\"status\":\"ok\"")) status = "ok";
                            else if (json.Contains("\"status\":\"error\"")) status = "error";
                        }
                    }
                }
                catch
                {
                    status = "not_responding";
                }
            }

            if (portOpen != isServerRunning || status != lastStatus || trayIcon.Text.Contains("Initializing"))
            {
                isServerRunning = portOpen;
                lastStatus = status;
                if (isServerRunning && status == "ok") isStarting = false;
                UpdateUI();
            }
        }

        private void UpdateUI()
        {
            if (!isServerRunning)
            {
                if (isStarting)
                {
                    trayIcon.Icon = orangeIcon;
                    trayIcon.Text = "gemini-proxy v" + Version + " - Starting...";
                    statusItem.Text = "gemini-proxy v" + Version + " - Starting...";
                }
                else
                {
                    trayIcon.Icon = redIcon;
                    trayIcon.Text = "gemini-proxy v" + Version + " - Stopped";
                    statusItem.Text = "gemini-proxy v" + Version + " - Stopped";
                }
                startServerItem.Enabled = !isStarting;
                stopServerItem.Enabled = isStarting;
                restartServerItem.Enabled = isStarting;
                openBrowserItem.Enabled = false;
            }
            else
            {
                if (lastStatus == "ok")
                {
                    trayIcon.Icon = mainIcon ?? greenIcon;
                    trayIcon.Text = string.Format("gemini-proxy v" + Version + " - Healthy (Port {0})", Port);
                    statusItem.Text = string.Format("gemini-proxy v" + Version + " - Healthy (Port {0})", Port);
                    isStarting = false;
                }
                else if (lastStatus == "error")
                {
                    trayIcon.Icon = blackIcon;
                    trayIcon.Text = "gemini-proxy v" + Version + " - Proxy Error";
                    statusItem.Text = "gemini-proxy v" + Version + " - Proxy Error";
                }
                else // not_responding or unknown
                {
                    trayIcon.Icon = orangeIcon;
                    trayIcon.Text = "gemini-proxy v" + Version + " - Connecting...";
                    statusItem.Text = "gemini-proxy v" + Version + " - Connecting...";
                }

                startServerItem.Enabled = false;
                stopServerItem.Enabled = true;
                restartServerItem.Enabled = true;
                openBrowserItem.Enabled = true;
            }
        }

        private bool IsPortInUse(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(300);
                    if (success && client.Connected)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private string GetBunPath()
        {
            // Check in environment PATH
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("where", "bun");
                psi.RedirectStandardOutput = true;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd().Split('\r', '\n')[0].Trim();
                    if (!string.IsNullOrEmpty(output) && File.Exists(output)) return output;
                }
            }
            catch { }

            // Check in user profile
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string userBun = Path.Combine(userProfile, ".bun", "bin", "bun.exe");
            if (File.Exists(userBun)) return userBun;

            return "bun"; // Fallback to PATH
        }

        private void StartServer()
        {
            try
            {
                if (string.IsNullOrEmpty(projectRoot) || (!File.Exists(Path.Combine(projectRoot, "src", "server.ts")) && !File.Exists(Path.Combine(projectRoot, "server.ts"))))
                {
                    MessageBox.Show("Project root folder is not set or invalid. Please right-click the tray icon and select 'Locate Project Folder...'", "Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    LocateProjectFolder();
                    if (string.IsNullOrEmpty(projectRoot) || (!File.Exists(Path.Combine(projectRoot, "src", "server.ts")) && !File.Exists(Path.Combine(projectRoot, "server.ts"))))
                    {
                        return;
                    }
                }

                string bunPath = GetBunPath();
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = string.Format("-NoProfile -ExecutionPolicy Bypass -Command \"Set-Location '{0}'; & '{1}' run src/server.ts\"", projectRoot.TrimEnd('\\'), bunPath);
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process.Start(psi);

                trayIcon.Text = "gemini-proxy - Starting...";
                isStarting = true;
                startServerItem.Enabled = false;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start server: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void StopServer()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = string.Format("-NoProfile -ExecutionPolicy Bypass -Command \"$conns = Get-NetTCPConnection -LocalPort {0} -ErrorAction SilentlyContinue; if ($conns) {{ foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {{ Stop-Process -Id $procId -Force }} }}; Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*src/server.ts*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}\"", Port);
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                Process.Start(psi);

                trayIcon.Text = "gemini-proxy - Stopping...";
                isStarting = false;
                stopServerItem.Enabled = false;
                restartServerItem.Enabled = false;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to stop server: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RestartServer()
        {
            try
            {
                // Update UI state to show restarting
                trayIcon.Icon = orangeIcon;
                trayIcon.Text = "gemini-proxy v" + Version + " - Restarting...";
                statusItem.Text = "gemini-proxy v" + Version + " - Restarting...";
                isStarting = true;
                UpdateUI(); // Refresh UI to disable menu items

                // Stop server synchronously to ensure cleanup before starting again
                ProcessStartInfo stopPsi = new ProcessStartInfo();
                stopPsi.FileName = "powershell.exe";
                stopPsi.Arguments = string.Format("-NoProfile -ExecutionPolicy Bypass -Command \"$conns = Get-NetTCPConnection -LocalPort {0} -ErrorAction SilentlyContinue; if ($conns) {{ foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {{ Stop-Process -Id $procId -Force }} }}; Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*src/server.ts*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}\"", Port);
                stopPsi.WindowStyle = ProcessWindowStyle.Hidden;
                stopPsi.CreateNoWindow = true;
                stopPsi.UseShellExecute = false;

                using (Process stopProc = Process.Start(stopPsi))
                {
                    if (stopProc != null)
                    {
                        stopProc.WaitForExit(5000); // Wait up to 5 seconds
                    }
                }

                // Brief pause to allow OS to release the port
                System.Threading.Thread.Sleep(500);

                // Start the server again
                StartServer();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to restart server: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                isStarting = false;
                PollStatus();
            }
        }

        private void OpenInBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo(string.Format("http://localhost:{0}/", Port)) { UseShellExecute = true });
            }
            catch { }
        }

        private void ToggleStartWithWindows()
        {
            bool newState = !startWithWindowsItem.Checked;
            SetStartWithWindows(newState);
            startWithWindowsItem.Checked = newState;
        }

        private void SetStartWithWindows(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (enable)
                    {
                        string appPath = Process.GetCurrentProcess().MainModule.FileName;
                        if (IsStartMinimized())
                        {
                            appPath += " --minimized";
                        }
                        key.SetValue(RegistryKeyName, string.Format("\"{0}\"", appPath));
                    }
                    else
                    {
                        key.DeleteValue(RegistryKeyName, false);
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to update registry: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private bool IsRegisteredForStartup()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
            {
                return key.GetValue(RegistryKeyName) != null;
            }
        }

        private void ToggleStartMinimized()
        {
            bool newState = !startMinimizedItem.Checked;
            SaveSettings(newState);
            startMinimizedItem.Checked = newState;
        }

        private bool IsStartMinimized()
        {
            if (!File.Exists(settingsFile)) return false;
            try
            {
                string content = File.ReadAllText(settingsFile);
                return content.Contains("\"startMinimized\": true");
            }
            catch { return false; }
        }

        private void SaveSettings(bool startMinimized)
        {
            try
            {
                string root = !string.IsNullOrEmpty(projectRoot) ? projectRoot.Replace("\\", "\\\\") : "";
                string json = string.Format("{{\n  \"startMinimized\": {0},\n  \"projectRoot\": \"{1}\"\n}}", startMinimized.ToString().ToLower(), root);
                File.WriteAllText(settingsFile, json);
            }
            catch { }
        }

        private void Exit()
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
            Application.Exit();
        }

        [STAThread]
        static void Main(string[] args)
        {
            FreeConsole();

            bool createdNew;
            using (System.Threading.Mutex mutex = new System.Threading.Mutex(true, "GeminiProxyLauncherMutex", out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherApp(args));
            }
        }
    }
}
