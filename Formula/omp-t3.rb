class OmpT3 < Formula
  desc "Connects T3 Code to Oh My Pi without code forks"
  homepage "https://github.com/hashangit/omp-t3"
  url "https://registry.npmjs.org/omp-t3/-/omp-t3-1.3.0-5.tgz"
  sha256 "b3d0a0e3f498e3a1e78c00346377e14cbc46755f1dfcb3d5f820485dd322d44f"
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
