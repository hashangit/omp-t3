class OmpT3 < Formula
  desc "Connects T3 Code to Oh My Pi without code forks"
  homepage "https://github.com/hashangit/omp-t3"
  url "https://registry.npmjs.org/omp-t3/-/omp-t3-1.4.0-5.tgz"
  sha256 "c0bd1d358eca9e30b3471bf951510f6de9717cdd69e4a30153e536235f631aa0"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "omp-t3", shell_output("#{bin}/omp-t3 --version")
  end
end
