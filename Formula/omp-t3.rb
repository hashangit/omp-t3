class OmpT3 < Formula
  desc "Connects T3 Code to Oh My Pi without code forks"
  homepage "https://github.com/hashangit/omp-t3"
  url "https://registry.npmjs.org/omp-t3/-/omp-t3-1.3.0-3.tgz"
  sha256 "d834d60f441ff29d5d5d3656c3e861c22a6d7ff1891ff520f10cdb5a70a9a02f"
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
